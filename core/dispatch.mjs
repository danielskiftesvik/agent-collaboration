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
import { headRef, captureWorkingDiff, captureWorkingTreeSnapshot, applyPatch, checkPatchApplies, workingTreeStatus, workingTreeDigest, newStatusPaths, stageDiffIntoWorktree, diffPaths, looksLikeDiff, extractUnifiedDiff } from "./git.mjs";
import { run } from "./process.mjs";
import { isPidAlive, isStalled, touchHeartbeat } from "./heartbeat.mjs";
import { coerceArtifact, normalizeReviewArtifact } from "./schema.mjs";
import { buildFromTemplate, templateDigest } from "./prompts.mjs";
import { classifyFailure, FALLBACK_KINDS } from "./failures.mjs";
import { MODEL_PROFILES, TASK_ROUTING, DEFAULT_ROUTING, WRITE_TASKS } from "./model-profiles.mjs";
import { version } from "./version.mjs";
import { checkPreflight } from "./preflight.mjs";

const TEMPLATE_KINDS = new Set(["review", "adversarial-review"]);

function commandOption(args, ...names) {
  const index = (args ?? []).findIndex((arg) => names.includes(arg));
  return index >= 0 ? args[index + 1] ?? null : null;
}

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
 * default so a healthy-but-quiet worker isn't false-killed. Per-worker profile
 * overrides can widen this for quiet deep reasoners. `AGENT_COLLAB_IDLE_TIMEOUT`
 * seconds; 0 disables.
 */
export function defaultIdleMs() {
  const s = Number(process.env.AGENT_COLLAB_IDLE_TIMEOUT);
  if (Number.isFinite(s)) return Math.max(0, Math.round(s * 1000)); // explicit (incl. 0 = off)
  return 600000; // 10 min — generous: only a worker silent AND idle on disk this long is "frozen"
}

/** Dirs whose file activity counts as progress for THIS worker job. */
function watchDirsFor(adapter, worker, workspace, artifactDir) {
  const dirs = [workspace];
  if (worker === "agy") {
    const agyLog = path.join(os.homedir(), ".gemini", "antigravity-cli", "log");
    try {
      if (fs.existsSync(agyLog)) dirs.push(agyLog);
    } catch {
      /* ignore */
    }
  }
  for (const p of adapter.progressDirs?.({ workspace, artifactDir }) ?? []) {
    try {
      // Create the job-scoped directory before idle-guard starts. Watching a
      // missing path is racy and would discard valid companion progress.
      fs.mkdirSync(p, { recursive: true });
      dirs.push(p);
    } catch {
      /* worker stdout/stderr + workspace activity remain available */
    }
  }
  return dirs;
}

/** Run a worker adapter's targeted lifecycle teardown and make failure visible. */
export function cleanupWorkerRuntime(worker, workspace, artifactDir) {
  const adapter = getAdapter(worker);
  const cmd = adapter.buildCleanupCommand?.({ workspace, artifactDir });
  if (!cmd) return { attempted: false, ok: true, reason: "adapter has no scoped runtime cleanup" };

  const cwd = workspace && fs.existsSync(workspace)
    ? workspace
    : artifactDir && fs.existsSync(artifactDir)
      ? artifactDir
      : process.cwd();
  const proc = run(cmd.command, cmd.args, {
    cwd,
    timeout: 10000,
    env: { ...process.env, ...(cmd.env ?? {}) }
  });
  let detail = null;
  try {
    detail = proc.stdout.trim() ? JSON.parse(proc.stdout) : null;
  } catch {
    detail = proc.stdout.trim() || null;
  }
  return {
    attempted: true,
    ok: proc.status === 0,
    status: proc.status,
    detail,
    error: proc.status === 0 ? undefined : (proc.stderr.trim() || proc.error?.message || "runtime cleanup failed")
  };
}

function canWrite(worker) {
  return MODEL_PROFILES[worker]?.canWrite !== false;
}

function canRunAsWriter(worker, env = process.env) {
  return canWrite(worker) || env.AGENT_COLLAB_ALLOW_NONWRITER === "on";
}

function splitPathList(value) {
  if (Array.isArray(value)) return value.flatMap(splitPathList);
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isExemptPath(file, patterns) {
  return patterns.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`));
}

function pathSet(paths) {
  return new Set(paths.map((p) => p.replace(/^\/+/, "")));
}

function stalledUpdate() {
  return {
    status: "failed",
    failureKind: "stalled",
    errors: ["the background worker process exited without writing a result"]
  };
}

export function refreshJobStatus(cwd, jobOrId) {
  const job = typeof jobOrId === "string" ? getJob(cwd, jobOrId) : jobOrId;
  if (!job || isTerminalStatus(job.status)) return job;
  const fresh = getJob(cwd, job.id) ?? job;
  if (!fresh || isTerminalStatus(fresh.status)) return fresh;
  let current = fresh;
  const progress = readProgress(current.progressFile);
  if (progress?.at && progress.at !== current.lastProgressAt) {
    current = updateJob(cwd, current.id, { lastProgressAt: progress.at, lastProgressKind: progress.kind });
  }
  if (current.pid && (isStalled(current, { staleMs: 0 }) || !isPidAlive(current.pid))) {
    return updateJob(cwd, current.id, stalledUpdate());
  }
  return current;
}

/**
 * Decide whether to wrap a worker run in the OS sandbox (preventive write
 * confinement — a belt to breach-detection's suspenders). Policy:
 *   - NEVER sandbox codex: it self-sandboxes (codex-companion's seatbelt), and
 *     nesting sandbox-exec fails ("Operation not permitted").
 *   - `AGENT_COLLAB_SANDBOX=off` (or config.sandbox===false) → never.
 *   - `AGENT_COLLAB_SANDBOX=on` (or config.sandbox===true) → on (non-codex).
 *   - Otherwise opt-in. agy write-workers need unsandboxed access to read linked
 *     worktree .git pointers; breach detection still catches live-tree escapes.
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
  const isDefaultRoute = !TASK_ROUTING[task];
  const avail = new Set(available);

  // For write/implementer tasks, exclude harnesses that can't deliver a patch
  // through the runtime.
  const isWrite = WRITE_TASKS.has(task);
  const canWork = (w) => !(isWrite && !canWrite(w));
  const explicitOnlyOk = (w) => !isDefaultRoute || !MODEL_PROFILES[w]?.explicitOnly;

  const cross = entry.workers.filter((w) => avail.has(w) && w !== driver && canWork(w) && explicitOnlyOk(w));
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
  if (entry.strict) {
    return {
      mode: "none",
      task,
      driver,
      worker: null,
      reason: `no worker-ready harness for this strict route (${entry.workers.join(", ")} unavailable)`
    };
  }
  const other = available.find((w) => w !== driver && canWork(w) && !MODEL_PROFILES[w]?.explicitOnly);
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
  const dirs = ["reports", "outputs", "logs"].concat(role === "worker" ? ["patches", "checks"] : []);
  for (const d of dirs) fs.mkdirSync(path.join(base, d), { recursive: true });
}

function dirtyPathsFromStatus(status) {
  return newStatusPaths(new Set(), status ?? []);
}

function redactArgs(args = []) {
  return args.map((arg, i) => {
    const s = String(arg);
    if (args[i - 1] === "-p" || args[i - 1] === "--prompt") return `<redacted:${s.length} chars>`;
    if (s.includes("\n") || s.length > 120) return `<redacted:${s.length} chars>`;
    return s;
  });
}

function appendAttemptDiagnostics(artifactDir, worker, attempt, cmd, proc, meta = {}) {
  const logsDir = path.join(artifactDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  fs.appendFileSync(path.join(logsDir, `${worker}.stdout.log`), stdout);
  fs.appendFileSync(path.join(logsDir, `${worker}.stderr.log`), stderr);
  fs.appendFileSync(
    path.join(logsDir, "run.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      worker,
      attempt,
      command: cmd.command,
      args: redactArgs(cmd.args ?? []),
      cwd: meta.cwd,
      exitCode: proc.status,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      sandboxRequested: meta.sandboxRequested,
      sandboxApplied: proc.sandboxApplied
    }) + "\n"
  );
}

function readProgress(progressFile) {
  if (!progressFile) return null;
  try {
    return JSON.parse(fs.readFileSync(progressFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Run a cross-harness worker/reviewer synchronously to completion. Workers run in
 * an isolated worktree; the captured patch is the artifact and is NOT applied
 * here (only the driver applies). Returns a summary including the artifact.
 */
export function runWorkerSync(cwd, opts) {
  const { driver, worker, role = "worker", brief, kind, focus, targetLabel, profile, surface, followupOf, timeoutMs = defaultTimeoutMs(), idleMs = MODEL_PROFILES[worker]?.idleMsOverride ?? defaultIdleMs(), maxAttempts = 2, noResume = false } = opts;
  const adapter = getAdapter(worker);
  const schema = role === "reviewer" ? reviewSchema : resultSchema;

  // A jobId may be supplied (background runs pre-create the record, then a detached
  // child executes it with that id); otherwise mint a fresh one.
  const jobId = opts.jobId || randomUUID();
  const artifactDir = path.join(resolveStateDir(cwd), "tasks", jobId);
  ensureDirs(artifactDir, role);
  fs.writeFileSync(path.join(artifactDir, "brief.md"), brief ?? "");
  const logs = {
    stdout: path.join(artifactDir, "logs", `${worker}.stdout.log`),
    stderr: path.join(artifactDir, "logs", `${worker}.stderr.log`),
    run: path.join(artifactDir, "logs", "run.jsonl"),
    progress: path.join(artifactDir, "logs", "progress.json")
  };

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
      baseRef: null, workspace: cwd, artifactDir, logs, heartbeatAt: new Date().toISOString()
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
        "Route implementation work to a worker with canWrite:true.",
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

  const launchStatus = isGitRepo
    ? opts.breachBefore
      ? new Set(opts.breachBefore)
      : workingTreeStatus(cwd)
    : null;
  const mainDirtyPathsAtLaunch = dirtyPathsFromStatus(launchStatus);
  let resolvedSurface = null;
  let sourceSnapshot = null;
  if (role === "reviewer" && TEMPLATE_KINDS.has(kind)) {
    if (surface && !["head", "working-tree", "diff"].includes(surface)) {
      return blocked(`unknown review surface '${surface}'; use head, working-tree, or diff`, "review-surface");
    }
    resolvedSurface = surface || (looksLikeDiff(brief) ? "diff" : mainDirtyPathsAtLaunch.length ? null : "head");
    if (!resolvedSurface) {
      return blocked(
        `review target is ambiguous because the checkout has uncommitted changes (${mainDirtyPathsAtLaunch.join(", ")}). ` +
          "Choose --surface working-tree to snapshot them, or --surface head to exclude them explicitly.",
        "review-surface"
      );
    }
    if (resolvedSurface === "diff" && !looksLikeDiff(brief)) {
      return blocked("--surface diff requires a unified diff as the review brief", "review-surface");
    }
    if (resolvedSurface === "working-tree") {
      try {
        sourceSnapshot = captureWorkingTreeSnapshot(cwd, baseRef);
      } catch (e) {
        return blocked(`could not snapshot the working tree for review (${e?.message || e})`, "review-surface");
      }
    }
  }
  if (isGitRepo) {
    const preflight = checkPreflight(cwd);
    if (!preflight.ok) {
      return blocked(`preflight failed: ${preflight.failures.join("; ")}`, "preflight");
    }
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
  const breachHeadBefore = worktree ? (opts.breachHeadBefore ?? baseRef) : null;
  const breachBefore = worktree ? launchStatus : null;
  const startedAt = new Date().toISOString();

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
    logs,
    progressFile: logs.progress,
    startedAt,
    timeoutMs,
    idleMs,
    heartbeatAt: startedAt,
    lastProgressAt: startedAt,
    lastProgressKind: "launch",
    profile: profile ?? null,
    runtimeVersion: version(),
    templateDigest: TEMPLATE_KINDS.has(kind) ? templateDigest(kind) : null,
    followupOf: followupOf ?? null
  });

  let answerText = "";
  let coerce = { ok: false, value: null, errors: ["no attempts ran"] };
  let exitCode = null;
  let lastStdout = "";
  let lastStderr = "";
  let timedOut = false;
  let frozen = false;
  let workerTelemetry = null;
  let resolvedModel = null;
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
  let reviewContext = role === "reviewer"
    ? {
        baseRef,
        workspace,
        surface: resolvedSurface,
        mainDirtyPathsAtLaunch,
        sourceStatusDigestAtLaunch: workingTreeDigest(breachBefore),
        sourceSnapshotDigest: sourceSnapshot?.digest ?? (resolvedSurface === "diff" ? workingTreeDigest(new Set([brief ?? ""])) : null),
        inputBytes: Buffer.byteLength(brief ?? ""),
        stagedIntoWorktree: false,
        stageReason: TEMPLATE_KINDS.has(kind) ? null : "no review diff staging for this command",
        stagedStat: ""
      }
    : undefined;
  if (TEMPLATE_KINDS.has(kind) && worktree) {
    const reviewDiff = resolvedSurface === "working-tree" ? sourceSnapshot.diff : resolvedSurface === "diff" ? extractUnifiedDiff(brief) : "";
    const staged = reviewDiff ? stageDiffIntoWorktree(workspace, reviewDiff) : { staged: false, reason: "HEAD surface selected" };
    if (reviewContext) {
      reviewContext.stagedIntoWorktree = staged.staged;
      reviewContext.stageReason = staged.staged ? null : staged.reason;
      reviewContext.stagedStat = staged.stat || "";
    }
    if (reviewDiff && !staged.staged) {
      removeWorktree(cwd, worktree);
      return blocked(`could not materialize the ${resolvedSurface} review surface (${staged.reason})`, "review-surface");
    }
    if (staged.staged) {
      reviewInput =
        "The change under review has been APPLIED to your working tree. Read the affected files " +
        "directly and run `git diff HEAD` to see exactly what changed — for large changes rely on " +
        "that rather than the pasted diff below.\n\nFiles changed:\n" +
        (staged.stat || "(run `git diff HEAD --stat`)") +
        "\n\nThe same change as a unified diff:\n" +
        reviewDiff;
    } else {
      reviewInput =
        `Review repository HEAD ${baseRef}. The driver explicitly selected the committed HEAD surface; ` +
        "uncommitted checkout changes are excluded. Use the context below only to focus your inspection.\n\n" +
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

  // Preventive OS-sandbox confinement (never codex; opt-in otherwise — see
  // resolveSandbox). If it can't actually be applied
  // we degrade to an unsandboxed run (breach detection stays active).
  const state = loadState(cwd);
  const wantSandbox = resolveSandbox({ worker, role, config: state.config, env: process.env }).sandbox;
  const wantStrict = process.env.AGENT_COLLAB_SANDBOX_STRICT === "on" || state.config.sandboxStrict === true;
  let sandboxDegraded = false;

  const watchDirs = watchDirsFor(adapter, worker, workspace, artifactDir);
  const exec = (cmd, sandbox) =>
    run(cmd.command, cmd.args, {
      cwd: workspace,
      timeout: timeoutMs,
      idleMs,
      watchDirs,
      env: MODEL_PROFILES[worker]?.cleanEnv
        ? { PATH: process.env.PATH, HOME: process.env.HOME, ...(cmd.env ?? {}) }
        : { ...process.env, ...(cmd.env ?? {}) },
      sandbox,
      sandboxStrict: wantStrict,
      sandboxWorkspace: workspace,
      sandboxArtifactDir: artifactDir,
      progressFile: logs.progress
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
    touchHeartbeat(cwd, jobId);
    let proc;
    let cmd;
    if (attempts === 1) {
      cmd = adapter.buildCommand({ role, brief: basePrompt, workspace, artifactDir, timeoutMs, profile });
      proc = execGuarded(cmd);
    } else {
      // Repair attempt: prefer RESUMING the worker's thread (cheap continuation,
      // faithful to the reference) when the adapter supports it; if the thread
      // can't be resumed, fall back to a fresh full re-send so resume never regresses.
      // Skip thread-resume when noResume (background runs): `--resume-last` resolves
      // the latest thread for the repo, which under concurrency could be a DIFFERENT
      // job's thread. Fall back to a fresh re-send instead.
      const retryCmd = (!noResume && adapter.buildRetryCommand)
        ? adapter.buildRetryCommand({ role, repairBrief: resumeRepair, workspace, artifactDir, timeoutMs })
        : null;
      if (retryCmd) {
        cmd = retryCmd;
        proc = execGuarded(cmd);
        if (adapter.isResumeMiss && adapter.isResumeMiss(proc)) {
          cmd = adapter.buildCommand({ role, brief: freshRepair, workspace, artifactDir, timeoutMs, profile });
          proc = execGuarded(cmd);
        }
      } else {
        cmd = adapter.buildCommand({ role, brief: freshRepair, workspace, artifactDir, timeoutMs, profile });
        proc = execGuarded(cmd);
      }
    }
    if (attempts === 1) {
      const requestedModel = commandOption(cmd.args, "--model", "-m");
      const requestedEffort = commandOption(cmd.args, "--effort");
      updateJob(cwd, jobId, {
        requestedModel,
        requestedEffort
      });
    }
    appendAttemptDiagnostics(artifactDir, worker, attempts, cmd, proc, {
      cwd: workspace,
      sandboxRequested: wantSandbox
    });
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
    workerTelemetry = parsed.telemetry ?? workerTelemetry;
    resolvedModel = parsed.telemetry?.resolvedModel ??
      (parsed.telemetry?.resolvedModels?.length === 1 ? parsed.telemetry.resolvedModels[0] : resolvedModel);
    answerText = parsed.answerText ?? "";
    const candidate = parsed.structured ? JSON.stringify(parsed.structured) : answerText;
    coerce = coerceArtifact(schema, candidate, normalize);
    if (coerce.ok) break;
    if (timedOut || frozen) break; // re-sending a frozen/too-slow prompt just hangs again — let the caller fall back
  }

  // Capture the worker's patch, then tear down the worktree (the diff is the artifact).
  let patchPath = null;
  let changed = false;
  let diff = "";
  let patchPaths = [];
  let patchApplies = role === "worker" ? true : null; // reviewers have no patch
  if (role === "worker") {
    try {
      diff = captureWorkingDiff(workspace, baseRef);
    } catch {
      diff = "";
    }
    changed = !!diff.trim();
    patchPaths = diffPaths(diff);
    patchApplies = changed ? checkPatchApplies(cwd, diff) : true;
    patchPath = path.join(artifactDir, "patches", `${worker}.diff`);
    fs.writeFileSync(patchPath, diff);
  }
  // Codex's upstream companion detaches an app-server broker. Its normal
  // SessionEnd hook never fires when agent-collaboration invokes the companion
  // as a subprocess, so explicitly tear down only this job's scoped broker before
  // removing the worktree used to derive its state key.
  const runtimeCleanup = cleanupWorkerRuntime(worker, workspace, artifactDir);
  if (worktree) removeWorktree(cwd, worktree);

  if (reviewContext) {
    const completionStatus = workingTreeStatus(cwd);
    reviewContext.sourceStatusDigestAtCompletion = workingTreeDigest(completionStatus);
    let completionHead = null;
    try { completionHead = headRef(cwd); } catch { /* recorded as mismatch */ }
    let contentMatches = reviewContext.sourceStatusDigestAtCompletion === reviewContext.sourceStatusDigestAtLaunch;
    if (reviewContext.surface === "working-tree") {
      try {
        contentMatches = captureWorkingTreeSnapshot(cwd, baseRef).digest === reviewContext.sourceSnapshotDigest;
      } catch {
        contentMatches = false;
      }
    }
    reviewContext.currentCheckoutMatchesSurface = completionHead === baseRef && contentMatches;
  }

  // Did the worker write OUTSIDE its worktree, into the driver's real tree?
  const rawEscapedPaths = worktree ? newStatusPaths(breachBefore, workingTreeStatus(cwd)) : [];
  let escapedPaths = rawEscapedPaths;
  let breachWarning;
  if (rawEscapedPaths.length) {
    const exemptions = splitPathList([process.env.AGENT_COLLAB_BREACH_EXEMPT_PATHS, opts.breachExemptPaths]);
    const exempted = rawEscapedPaths.filter((p) => isExemptPath(p, exemptions));
    escapedPaths = rawEscapedPaths.filter((p) => !isExemptPath(p, exemptions));
    const headAfter = worktree ? headRef(cwd) : null;
    const headMoved = !!(breachHeadBefore && headAfter && breachHeadBefore !== headAfter);
    const patched = pathSet(patchPaths);
    const disjointFromPatch = escapedPaths.length > 0 && escapedPaths.every((p) => !patched.has(p));
    const cleanArtifact =
      role === "worker"
        ? changed && patchApplies
        : !timedOut && !frozen && exitCode === 0 && answerText.trim().length > 0;
    const warnConcurrent = process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT === "on" || opts.breachWarnConcurrent === true;
    const warningPaths = [...exempted];
    if (escapedPaths.length && warnConcurrent && cleanArtifact && (headMoved || disjointFromPatch)) {
      warningPaths.push(...escapedPaths);
      escapedPaths = [];
    }
    if (warningPaths.length) breachWarning = { escapedPaths: warningPaths, headMoved };
  }

  fs.writeFileSync(path.join(artifactDir, "reports", `${worker}.md`), answerText);
  fs.writeFileSync(
    path.join(artifactDir, "outputs", `${worker}.json`),
    JSON.stringify(coerce.value ?? { raw: answerText }, null, 2)
  );

  // A worker's deliverable is the PATCH, not the result-JSON. So a real,
  // cleanly-applying patch means success even if the metadata JSON is missing.
  // A reviewer's structured result must validate, but prose is still useful
  // when the JSON is malformed.
  let status;
  const reviewerHasReport =
    role === "reviewer" && !coerce.ok && !timedOut && !frozen && exitCode === 0 && answerText.trim().length > 0;
  if (role === "reviewer") {
    status = coerce.ok || reviewerHasReport ? "completed" : "failed";
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
  // captured diff likely wrote somewhere other than the isolated worktree. Make
  // the silent no-changes actionable instead of a filesystem hunt.
  let note;
  if (status === "no-changes" && coerce.ok && coerce.value.changed === true) {
    note =
      "the worker reported it changed files, but nothing was captured in its isolated worktree — " +
      "it likely wrote somewhere else. Treated as no-changes; this run produced no patch.";
  }
  if (sandboxDegraded) {
    note = (note ? note + " " : "") +
      "OS sandbox could not be applied in this environment; ran unsandboxed — breach detection still active.";
  }
  if (reviewerHasReport) {
    note = (note ? note + " " : "") +
      "Reviewer returned prose but invalid JSON; report was saved. Read the prose report instead of discarding the review.";
  }
  if (breachWarning) {
    note = (note ? note + " " : "") +
      `Real checkout changed during the worker run (${breachWarning.escapedPaths.join(", ")}); recorded as breachWarning, not a hard breach.`;
  }
  if (role === "reviewer" && reviewContext?.surface === "head" && reviewContext.mainDirtyPathsAtLaunch?.length) {
    note = (note ? note + " " : "") +
      `Review surface was explicitly set to HEAD; uncommitted paths were excluded (${reviewContext.mainDirtyPathsAtLaunch.join(", ")}).`;
  }
  if (role === "reviewer" && reviewContext && !reviewContext.currentCheckoutMatchesSurface) {
    note = (note ? note + " " : "") +
      `The driver checkout changed while the review ran; the verdict applies to the captured ${reviewContext.surface || "review"} surface.`;
  }
  if (runtimeCleanup.attempted && !runtimeCleanup.ok) {
    note = (note ? note + " " : "") +
      `Worker runtime cleanup failed (${runtimeCleanup.error}); inspect the job metadata before launching more ${worker} work.`;
  }
  const sandboxed = wantSandbox && !sandboxDegraded;
  const completedAt = new Date().toISOString();
  const durationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());

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
    breachWarning,
    report: role === "reviewer" && answerText.trim().length > 0,
    logs,
    progressFile: logs.progress,
    reviewContext,
    sandboxed,
    completedAt,
    durationMs,
    workerTelemetry,
    resolvedModel,
    runtimeCleanup,
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
    breachWarning,
    report: role === "reviewer" && answerText.trim().length > 0,
    logs,
    reviewContext,
    sandboxed,
    completedAt,
    durationMs,
    workerTelemetry,
    resolvedModel,
    runtimeCleanup,
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
 *   off  -> none;  on -> rate-limit+auth+timeout+frozen+empty-output;  "a,b" -> exactly those kinds.
 * DEFAULT = rate-limit + timeout + frozen + empty-output: fall back on TRANSIENT
 * capacity/runtime problems (another worker can do it right now), but SURFACE auth —
 * it's a persistent config issue, so routing around the worker the user chose would
 * just hide a login they must fix.
 */
export function resolveFallbackKinds(env = process.env) {
  const v = env.AGENT_COLLAB_FALLBACK;
  if (v === "off") return new Set();
  if (v === "on") return new Set(["rate-limit", "auth", "timeout", "frozen", "empty-output"]);
  if (v) return new Set(v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  return new Set(FALLBACK_KINDS);
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
  const explicitWorkerIsExclusive = worker && MODEL_PROFILES[worker]?.explicitOnly === true;
  if (!explicitWorkerIsExclusive) {
    for (const w of avail) {
      if (
        w &&
        w !== driver &&
        !candidates.includes(w) &&
        !MODEL_PROFILES[w]?.explicitOnly &&
        (!isWrite || canRunAsWriter(w))
      )
        candidates.push(w);
    }
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
  const { driver, worker, role = "worker", brief, kind, focus, targetLabel, profile, surface, timeoutMs, maxAttempts } = opts;
  const resolvedTimeoutMs = timeoutMs ?? defaultTimeoutMs();
  const resolvedIdleMs = opts.idleMs ?? MODEL_PROFILES[worker]?.idleMsOverride ?? defaultIdleMs();
  const launchedAt = new Date().toISOString();
  const jobId = randomUUID();
  const artifactDir = path.join(resolveStateDir(cwd), "tasks", jobId);
  ensureDirs(artifactDir, role);
  fs.writeFileSync(path.join(artifactDir, "brief.md"), brief ?? "");
  let breachHeadBefore = null;
  let breachBefore = null;
  try {
    breachHeadBefore = headRef(cwd);
    const s = workingTreeStatus(cwd);
    breachBefore = s ? [...s] : null;
  } catch {
    // best-effort; runWorkerSync will snapshot if this failed
  }

  appendJob(cwd, {
    id: jobId,
    driver,
    worker,
    role,
    status: "queued",
    background: true,
    artifactDir,
    request: {
      driver, worker, role, brief, kind, focus, targetLabel, profile, surface,
      timeoutMs: resolvedTimeoutMs, idleMs: resolvedIdleMs, maxAttempts,
      breachHeadBefore, breachBefore
    },
    timeoutMs: resolvedTimeoutMs,
    idleMs: resolvedIdleMs,
    startedAt: launchedAt,
    heartbeatAt: launchedAt,
    lastProgressAt: launchedAt,
    lastProgressKind: "launch"
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
    job = refreshJobStatus(cwd, job) ?? job;
    if (!job || isTerminalStatus(job.status)) break;
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
  const paths = diffPaths(diff);
  const stat = diff.trim() ? run("git", ["apply", "--stat"], { cwd, input: diff }).stdout.trim() : "";
  const result = applyPatch(cwd, diff);
  const out = { ...result, paths, stat };
  updateJob(cwd, jobId, { applied: result.applied, conflicted: result.conflicted, appliedPaths: paths, diffStat: stat });
  return out;
}
