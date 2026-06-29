// The companion's brain: decide native vs cross-harness routing, probe harnesses
// for `setup`, and run a cross-harness worker/reviewer to completion, producing
// validated artifacts that only the driver later applies.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAdapter, listAdapters } from "../adapters/index.mjs";
import { resolveStateDir, appendJob, updateJob, getJob, loadState, isTerminalStatus } from "./state.mjs";
import { createWorktree, removeWorktree } from "./workspace.mjs";
import { headRef, captureWorkingDiff, applyPatch, checkPatchApplies, workingTreeStatus, newStatusPaths, stageDiffIntoWorktree } from "./git.mjs";
import { run } from "./process.mjs";
import { isPidAlive } from "./heartbeat.mjs";
import { coerceArtifact, normalizeReviewArtifact } from "./schema.mjs";
import { buildFromTemplate } from "./prompts.mjs";
import { classifyFailure } from "./failures.mjs";
import { MODEL_PROFILES, TASK_ROUTING, DEFAULT_ROUTING, WRITE_TASKS } from "./model-profiles.mjs";

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
 * Inactivity (idle) budget: if a worker produces NO output for this long it's
 * treated as FROZEN and killed fast — well before the hard timeout. Generous by
 * default so a healthy-but-quiet worker isn't false-killed (codex streams progress;
 * agy is fast). `AGENT_COLLAB_IDLE_TIMEOUT` seconds; 0 disables.
 */
export function defaultIdleMs() {
  const s = Number(process.env.AGENT_COLLAB_IDLE_TIMEOUT);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000)); // explicit (incl. 0 = off)
  return 600000; // 10 min — generous: only a worker silent AND idle on disk this long is "frozen"
}

/** Dirs whose file activity counts as worker progress for the idle watchdog: the
 *  worktree, plus (for agy) its own log dir, since agy streams progress there. */
function watchDirsFor(worker, workspace) {
  const dirs = [workspace];
  if (worker === "agy") {
    const agyLog = path.join(os.homedir(), ".gemini", "antigravity-cli", "log");
    try {
      if (fs.existsSync(agyLog)) dirs.push(agyLog);
    } catch {
      /* ignore */
    }
  }
  return dirs;
}

function canWrite(worker) {
  return MODEL_PROFILES[worker]?.canWrite !== false;
}

function canRunAsWriter(worker, env = process.env) {
  return canWrite(worker) || env.AGENT_COLLAB_ALLOW_NONWRITER === "on";
}

/**
 * Decide whether to wrap a worker run in the OS sandbox (preventive write
 * confinement — a belt to breach-detection's suspenders). Policy:
 *   - NEVER sandbox codex: it self-sandboxes (codex-companion's seatbelt), and
 *     nesting sandbox-exec fails ("Operation not permitted").
 *   - `AGENT_COLLAB_SANDBOX=off` (or config.sandbox===false) → never.
 *   - `AGENT_COLLAB_SANDBOX=on` (or config.sandbox===true) → on (non-codex).
 *   - Otherwise DEFAULT-ON for agy WRITE-workers: agy runs unattended
 *     (--dangerously-skip-permissions) and doesn't self-sandbox, so confine its
 *     writes. Reviewers and other harnesses stay opt-in (don't risk the working
 *     review path; breach detection still covers escapes).
 * If the sandbox can't actually be applied at runtime, the caller degrades to an
 * unsandboxed run (breach detection remains active).
 */
export function resolveSandbox({ worker, role = "worker", config = {}, env = process.env } = {}) {
  if (worker === "codex") return { sandbox: false, reason: "codex self-sandboxes (no nesting)" };
  if (config.sandbox === false || env.AGENT_COLLAB_SANDBOX === "off") {
    return { sandbox: false, reason: "disabled" };
  }
  if (config.sandbox === true || env.AGENT_COLLAB_SANDBOX === "on") {
    return { sandbox: true, reason: "enabled" };
  }
  if (worker === "agy" && role === "worker") {
    // agy write-workers previously defaulted to sandbox:true, but this breaks agy's
    // ability to verify the .git worktree file (which points outside the sandbox).
    // Now that patch-harvesting works reliably, we let breach-detection handle escapes.
    return { sandbox: false, reason: "agy needs unsandboxed access to read .git worktree pointers" };
  }
  return { sandbox: false, reason: "opt-in" };
}

/** Did the sandbox WRAPPER fail to start (vs. a real task error or a correct
 *  in-sandbox denial)? Must NOT match a bare "operation not permitted" — that's
 *  exactly what a *correctly* sandbox-denied write prints (EPERM), and treating it
 *  as a wrapper failure would re-run unsandboxed and let the denied write through. */
export function isSandboxStartupFailure(proc) {
  if (!proc || proc.status === 0) return false;
  if (proc.error && proc.error.code === "ETIMEDOUT") return false; // a timeout is not a sandbox failure
  const t = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  return /sandbox_apply|sandbox profile|^bwrap:|\nbwrap:/i.test(t);
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

  // For write/implementer tasks, exclude harnesses that can't deliver a patch
  // through the runtime (agy writes to its own scratch, not the worktree).
  const isWrite = WRITE_TASKS.has(task);
  const canWork = (w) => !(isWrite && !canWrite(w));

  const cross = entry.workers.filter((w) => avail.has(w) && w !== driver && canWork(w));
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
  const other = available.find((w) => w !== driver && canWork(w));
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
  const { driver, worker, role = "worker", brief, kind, focus, targetLabel, timeoutMs = defaultTimeoutMs(), idleMs = defaultIdleMs(), maxAttempts = 2, noResume = false } = opts;
  const adapter = getAdapter(worker);
  const schema = role === "reviewer" ? reviewSchema : resultSchema;

  // A jobId may be supplied (background runs pre-create the record, then a detached
  // child executes it with that id); otherwise mint a fresh one.
  const jobId = opts.jobId || randomUUID();
  const artifactDir = path.join(resolveStateDir(cwd), "tasks", jobId);
  ensureDirs(artifactDir, role);
  fs.writeFileSync(path.join(artifactDir, "brief.md"), brief ?? "");

  // Write the initial record idempotently: appendJob for a brand-new job, updateJob
  // when the parent (background launch) already created it.
  const writeInitial = (rec) => {
    if (getJob(cwd, jobId)) updateJob(cwd, jobId, rec);
    else appendJob(cwd, rec);
  };

  // Both workers AND reviewers run in an ephemeral worktree so an unattended
  // harness (e.g. `agy --dangerously-skip-permissions`) can never write to the
  // live tree. Only a worker's changes are captured as a patch; a reviewer's are
  // discarded with the worktree.
  const blocked = (reason, failureKind = "isolation") => {
    const errors = [reason];
    writeInitial({
      id: jobId, driver, worker, role, status: "blocked", pid: process.pid,
      baseRef: null, workspace: cwd, artifactDir, heartbeatAt: new Date().toISOString()
    });
    updateJob(cwd, jobId, { errors, failureKind });
    return {
      jobId, worker, status: "blocked", resultValid: false, valid: false,
      changed: false, patchApplies: null, artifact: null, artifactDir,
      patchPath: null, isolated: false, failureKind, errors
    };
  };

  if (role === "worker" && !canRunAsWriter(worker)) {
    return blocked(
      `${worker} is reviewer-only through this runtime and cannot deliver patches as a write-worker. ` +
        "Route implementation work to codex or claude; use agy for review/planning.",
      "unsupported-worker"
    );
  }

  let baseRef = null;
  let workspace = cwd;
  let worktree = null;
  let isGitRepo = false;
  try {
    baseRef = headRef(cwd);
    isGitRepo = true;
  } catch {
    isGitRepo = false;
  }
  if (isGitRepo) {
    // A real repo MUST be isolated. If the worktree can't be created, FAIL CLOSED —
    // never fall back to the real checkout (AGENT_COLLAB_ALLOW_INPLACE does NOT apply
    // inside a repo, so a transient worktree error can't silently uncontain writes).
    try {
      worktree = createWorktree(cwd, jobId, baseRef);
      workspace = worktree;
    } catch (e) {
      return blocked(
        "cannot isolate the worker — git worktree creation failed inside this repository " +
          `(${e?.message || e}). Failing closed so the worker never writes to your real checkout. ` +
          "Retry, or clean up stale worktrees (git worktree prune)."
      );
    }
  } else if (process.env.AGENT_COLLAB_ALLOW_INPLACE === "on") {
    workspace = cwd; // genuinely not a git repo + explicit opt-in: unsafe in-place run
  } else {
    return blocked(
      "cannot isolate the worker — the cwd is not a git repository, so no worktree can be " +
        "created. cd into a git repo, or set AGENT_COLLAB_ALLOW_INPLACE=on to run UNISOLATED (unsafe)."
    );
  }

  // Breach detection: snapshot the driver's REAL tree so we can tell if an
  // unattended worker escapes its worktree and writes into the live checkout
  // (observed with agy resolving the canonical $HOME repo under
  // --dangerously-skip-permissions). Only meaningful when we actually isolated;
  // in the run-in-place fallback the worker is supposed to write to cwd.
  const breachBefore = worktree ? workingTreeStatus(cwd) : null;

  writeInitial({
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
  let frozen = false;
  // Reviewers' output is normalized (severity case, etc.) before validation so a
  // complete report isn't false-failed over cosmetics; workers are not.
  const normalize = role === "reviewer" ? normalizeReviewArtifact : undefined;
  // Harness-aware output contract: each adapter may tune how it asks for the
  // structured shape (agy gets emphatic JSON-only; codex gets XML blocks);
  // otherwise fall back to the generic instruction.
  const contract = adapter.outputContract ? adapter.outputContract(role) : schemaInstruction(role);

  // Review-grade work uses a code-loaded template (with the harness contract
  // filling {{OUTPUT_CONTRACT}}); free-form work is the driver-composed brief.
  // For review-grade work, try to STAGE the diff into the worktree so the reviewer
  // reads real post-change files (not a stale HEAD baseline) — the diff is still
  // included for small changes. Falls back to pasted-text when it isn't a diff or
  // doesn't apply.
  let reviewInput = brief ?? "";
  if (TEMPLATE_KINDS.has(kind) && worktree) {
    const staged = stageDiffIntoWorktree(workspace, brief ?? "");
    if (staged.staged) {
      reviewInput =
        "The change under review has been APPLIED to your working tree. Read the affected files " +
        "directly and run `git diff HEAD` to see exactly what changed — for large changes rely on " +
        "that rather than the pasted diff below.\n\nFiles changed:\n" +
        (staged.stat || "(run `git diff HEAD --stat`)") +
        "\n\nThe same change as a unified diff:\n" +
        (brief ?? "");
    } else {
      reviewInput =
        "Your working tree is the repository's HEAD baseline; the change under review is the unified " +
        "diff below, which is AUTHORITATIVE — do not 'correct' based on baseline code the diff changes.\n\n" +
        (brief ?? "");
    }
  }
  const basePrompt = TEMPLATE_KINDS.has(kind)
    ? buildFromTemplate(kind, {
        TARGET_LABEL: targetLabel || "the provided changes",
        USER_FOCUS: focus || "No extra focus provided.",
        REVIEW_INPUT: reviewInput,
        OUTPUT_CONTRACT: contract
      })
    : `${brief ?? ""}${contract}`;

  // Preventive OS-sandbox confinement (default-on for agy write-workers; never
  // codex; opt-in otherwise — see resolveSandbox). If it can't actually be applied
  // we degrade to an unsandboxed run (breach detection stays active).
  const state = loadState(cwd);
  const wantSandbox = resolveSandbox({ worker, role, config: state.config, env: process.env }).sandbox;
  const wantStrict = process.env.AGENT_COLLAB_SANDBOX_STRICT === "on" || state.config.sandboxStrict === true;
  let sandboxDegraded = false;

  const watchDirs = watchDirsFor(worker, workspace);
  const exec = (cmd, sandbox) =>
    run(cmd.command, cmd.args, {
      cwd: workspace,
      timeout: timeoutMs,
      idleMs,
      watchDirs,
      env: { ...process.env, ...(cmd.env ?? {}) },
      sandbox,
      sandboxStrict: wantStrict,
      sandboxWorkspace: workspace,
      sandboxArtifactDir: artifactDir
    });
  // Run with the sandbox; degrade to unsandboxed if it couldn't be applied
  // (e.g. no bwrap → run() reports sandboxApplied:false and has already run
  // unsandboxed) or the wrapper failed to start (retry once unsandboxed).
  const execGuarded = (cmd) => {
    let p = exec(cmd, wantSandbox);
    if (wantSandbox) {
      if (p.sandboxApplied === false) {
        sandboxDegraded = true; // requested but not applied; already ran unsandboxed
      } else if (isSandboxStartupFailure(p)) {
        sandboxDegraded = true;
        p = exec(cmd, false);
      }
    }
    return p;
  };

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
      proc = execGuarded(adapter.buildCommand({ role, brief: basePrompt, workspace, timeoutMs }));
    } else {
      // Repair attempt: prefer RESUMING the worker's thread (cheap continuation,
      // faithful to the reference) when the adapter supports it; if the thread
      // can't be resumed, fall back to a fresh full re-send so resume never regresses.
      // Skip thread-resume when noResume (background runs): `--resume-last` resolves
      // the latest thread for the repo, which under concurrency could be a DIFFERENT
      // job's thread. Fall back to a fresh re-send instead.
      const retryCmd = (!noResume && adapter.buildRetryCommand)
        ? adapter.buildRetryCommand({ role, repairBrief: resumeRepair, workspace, timeoutMs })
        : null;
      if (retryCmd) {
        proc = execGuarded(retryCmd);
        if (adapter.isResumeMiss && adapter.isResumeMiss(proc)) {
          proc = execGuarded(adapter.buildCommand({ role, brief: freshRepair, workspace, timeoutMs }));
        }
      } else {
        proc = execGuarded(adapter.buildCommand({ role, brief: freshRepair, workspace, timeoutMs }));
      }
    }
    exitCode = proc.status;
    lastStdout = proc.stdout ?? "";
    lastStderr = proc.stderr ?? "";
    // The idle-guard kills a FROZEN run (no output for the idle window) or one that
    // overran the hard timeout, exiting 124 with a marker on stderr. (ETIMEDOUT is a
    // backstop if the guard itself wedged.) Either way: don't pointlessly re-send.
    frozen = /\[idle-guard\] no output for/.test(lastStderr);
    timedOut =
      !frozen &&
      (/\[idle-guard\] hard timeout/.test(lastStderr) ||
        !!(proc.error && (proc.error.code === "ETIMEDOUT" || /tim(?:ed)?\s*out/i.test(proc.error.message || ""))));
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
    if (timedOut || frozen) break; // re-sending a frozen/too-slow prompt just hangs again — let the caller fall back
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
    if (frozen) {
      failureKind = "frozen";
      errors = [
        `worker produced NO output for ${Math.round(idleMs / 1000)}s — treated as frozen and killed ` +
          `(well before the ${Math.round(timeoutMs / 1000)}s hard timeout). Tune with AGENT_COLLAB_IDLE_TIMEOUT ` +
          `(0 disables), or let it auto-fall-back to another worker.`
      ];
    } else if (timedOut) {
      failureKind = "timeout";
      errors = [
        `worker exceeded the ${Math.round(timeoutMs / 1000)}s hard timeout and was killed mid-run. ` +
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

  // Diagnostic: a worker that self-reports it changed files but left an EMPTY
  // captured diff almost certainly wrote OUTSIDE the worktree it was handed (agy
  // 1.0.13 ignores cwd/--add-dir and writes to ~/.gemini/.../scratch). Make the
  // silent no-changes actionable instead of a filesystem hunt.
  let note;
  if (status === "no-changes" && coerce.ok && coerce.value.changed === true) {
    note =
      "the worker reported it changed files, but nothing was captured in its isolated worktree — " +
      "it likely wrote OUTSIDE the worktree (agy writes to ~/.gemini/antigravity-cli/scratch/). " +
      "Treated as no-changes; this worker can't deliver a patch through the runtime here.";
  }
  if (sandboxDegraded) {
    note = (note ? note + " " : "") +
      "OS sandbox could not be applied in this environment; ran unsandboxed — breach detection still active.";
  }
  const sandboxed = wantSandbox && !sandboxDegraded;

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
    sandboxed,
    note,
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
    sandboxed,
    note,
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
 * explicitly or it is probed. Which failure kinds trigger fallback is policy:
 * pass `fallbackKinds` (a Set), or `fallback: false` to disable, else the default
 * policy (`resolveFallbackKinds`) applies.
 */
/**
 * Which failure kinds auto-trigger fallback. Policy via AGENT_COLLAB_FALLBACK:
 *   off  -> none;  on -> rate-limit+auth+timeout;  "a,b" -> exactly those kinds.
 * DEFAULT = rate-limit + timeout: fall back on TRANSIENT capacity problems (another
 * worker can do it right now), but SURFACE auth — it's a persistent config issue, so
 * routing around the worker the user chose would just hide a login they must fix.
 */
export function resolveFallbackKinds(env = process.env) {
  const v = env.AGENT_COLLAB_FALLBACK;
  if (v === "off") return new Set();
  if (v === "on") return new Set(["rate-limit", "auth", "timeout", "frozen"]);
  if (v) return new Set(v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return new Set(["rate-limit", "timeout", "frozen"]);
}

export function runWithFallback(cwd, opts) {
  const { driver, worker, available, fallback, fallbackKinds, task, ...rest } = opts;
  const kinds =
    fallbackKinds instanceof Set
      ? fallbackKinds
      : fallback === false
        ? new Set()
        : resolveFallbackKinds();
  const avail =
    available || runSetup().filter((r) => r.validWorker).map((r) => r.name);

  // Candidate order: the EXPLICITLY-requested worker first — always honored, even
  // if it equals the (possibly merely guessed) driver label — then the remaining
  // worker-ready harnesses as auto-fallbacks, which DO exclude the driver so a
  // fallback never spawns the driver's own harness behind its back.
  const candidates = [];
  if (worker) candidates.push(worker);
  const isWrite = (rest.role ?? "worker") === "worker" || (task && WRITE_TASKS.has(task));
  for (const w of avail) {
    if (w && w !== driver && !candidates.includes(w) && (!isWrite || canRunAsWriter(w))) candidates.push(w);
  }

  const fellBackFrom = [];
  let last = null;
  for (const w of candidates) {
    const res = runWorkerSync(cwd, { driver, worker: w, ...rest });
    last = res;
    const limited = res.status === "failed" && kinds.has(res.failureKind);
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
      "All worker-ready harnesses failed in a fall-back-eligible way: " +
      fellBackFrom
        .map((f) => `${f.worker} (${f.failureKind}${f.resetAt ? `, resets ${f.resetAt}` : ""})`)
        .join("; ") +
      ". Surface this to the user — do not silently complete the task single-party.";
  }
  return last;
}

// ---- async background execution (brokerless convergence to the reference's model) ----

export { isTerminalStatus } from "./state.mjs";

/** Block synchronously for ms without busy-waiting (the CLI is synchronous). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

const COMPANION = fileURLToPath(new URL("../scripts/agent-companion.mjs", import.meta.url));

/**
 * Launch a worker as a DETACHED background job — the reference's async model, minus
 * the app-server broker. Pre-creates the job record + persists the request, spawns a
 * detached `run-job` child that runs it to completion via runWorkerSync, and returns
 * immediately. The run survives a driver crash; `status`/`result`/`cancel`/`--wait`
 * poll or act on the record. Background runs a SINGLE worker (no auto-fallback — that
 * stays a synchronous-path convenience).
 */
export function launchBackground(cwd, opts) {
  const { driver, worker, role = "worker", brief, kind, focus, targetLabel, timeoutMs, maxAttempts } = opts;
  const jobId = randomUUID();
  const artifactDir = path.join(resolveStateDir(cwd), "tasks", jobId);
  ensureDirs(artifactDir, role);
  fs.writeFileSync(path.join(artifactDir, "brief.md"), brief ?? "");

  appendJob(cwd, {
    id: jobId,
    driver,
    worker,
    role,
    status: "queued",
    background: true,
    artifactDir,
    request: { driver, worker, role, brief, kind, focus, targetLabel, timeoutMs, maxAttempts },
    heartbeatAt: new Date().toISOString()
  });

  const logFd = fs.openSync(path.join(artifactDir, "run.log"), "a");
  const child = spawn(process.execPath, [COMPANION, "run-job", "--job", jobId], {
    cwd,
    env: process.env,
    detached: true, // own process group, so `cancel` can kill the worker subtree
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  updateJob(cwd, jobId, { pid: child.pid, status: "running" });

  return { jobId, worker, status: "running", background: true, artifactDir };
}

/** Detached-worker entrypoint: load the persisted request and run it under jobId. */
export function runJob(cwd, jobId) {
  const job = getJob(cwd, jobId);
  if (!job || !job.request) throw new Error(`run-job: no stored request for ${jobId}`);
  // Background runs are concurrency-prone → disable codex thread-resume (would risk
  // resuming another job's --resume-last thread).
  return runWorkerSync(cwd, { ...job.request, jobId, noResume: true });
}

/**
 * Poll a job until it reaches a terminal status, the deadline passes, or its process
 * has died without finishing (stalled). Synchronous (blocking) — powers `status --wait`.
 */
export function waitForJob(cwd, jobId, { timeoutMs = 1800000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let job = getJob(cwd, jobId);
  while (job && !isTerminalStatus(job.status)) {
    if (job.pid && !isPidAlive(job.pid)) {
      job = updateJob(cwd, jobId, {
        status: "failed",
        failureKind: "stalled",
        errors: ["the background worker process exited without writing a result"]
      });
      break;
    }
    if (Date.now() >= deadline) break;
    sleepSync(pollMs);
    job = getJob(cwd, jobId);
  }
  return job;
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
