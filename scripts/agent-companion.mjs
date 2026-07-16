#!/usr/bin/env node
// agent-collaboration companion CLI. Generalized from codex-plugin-cc's
// codex-companion.mjs (Apache-2.0, Copyright 2026 OpenAI) into a harness-agnostic
// dispatcher. Slash commands are thin wrappers over these subcommands.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideRoute, resolveDriver, isAuthoritativeDriver, runSetup, runWorkerSync, runWithFallback, resolveFallbackKinds, launchBackground, runJob, waitForJob, refreshJobStatus, applyResult, recommendWorker, cleanupWorkerRuntime } from "../core/dispatch.mjs";
import { runDoctor } from "../core/doctor.mjs";
import { mergeReviews } from "../core/merge-reviews.mjs";
import { version } from "../core/version.mjs";
import { listJobs, getJob, updateJob, sortJobsNewestFirst, loadState, saveState, resolveStateDir, isTerminalStatus } from "../core/state.mjs";
import { isPidAlive, projectJobHealth } from "../core/heartbeat.mjs";
import { renderSetup, renderJob, renderJobList, renderRecommendation, renderProfiles } from "../core/render.mjs";
import { MODEL_PROFILES } from "../core/model-profiles.mjs";
import { cleanupJobWorktree, collectGarbage, waitForPidExit } from "../core/gc.mjs";

const VALUE_FLAGS = new Set(["worker", "workers", "role", "driver", "base", "timeout", "gate", "sandbox", "focus", "surface", "task", "job", "recent", "retention-days", "artifacts-older-than"]);
const BOOL_FLAGS = new Set(["json", "apply", "wait", "background", "profiles", "no-fallback", "live", "active", "latest", "refresh", "artifact-only", "force", "dry-run", "include-unapplied"]);

function parseArgs(tokens) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      if (BOOL_FLAGS.has(key)) options[key] = true;
      else if (VALUE_FLAGS.has(key)) options[key] = tokens[++i];
      else options[key] = tokens[++i]; // tolerate unknown value flags
    } else {
      positionals.push(t);
    }
  }
  return { options, positionals };
}

function out(json, options, human) {
  if (options.json) process.stdout.write(JSON.stringify(json, null, options.compact ? 0 : 2) + "\n");
  else process.stdout.write((human ?? renderDefault(json)) + "\n");
}

function renderDefault(json) {
  return typeof json === "string" ? json : JSON.stringify(json, null, 2);
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

function filterJobs(jobs, options) {
  return jobs.filter((job) =>
    (!options.worker || job.worker === options.worker) &&
    (!options.role || job.role === options.role) &&
    (!options.active || !isTerminalStatus(job.status))
  );
}

function latestCreatedJob(jobs) {
  return jobs.reduce(
    (latest, job) =>
      !latest || String(job.createdAt ?? "").localeCompare(String(latest.createdAt ?? "")) >= 0 ? job : latest,
    null
  );
}

function withHealth(job) {
  return job ? { ...job, health: projectJobHealth(job) } : job;
}

function resultJobMetadata(job) {
  return {
    id: job.id,
    driver: job.driver,
    worker: job.worker,
    role: job.role,
    status: job.status,
    resultValid: job.resultValid,
    failureKind: job.failureKind,
    errors: job.errors,
    note: job.note,
    reviewContext: job.reviewContext,
    breachWarning: job.breachWarning,
    breach: job.breach,
    escapedPaths: job.escapedPaths,
    sandboxed: job.sandboxed,
    requestedModel: job.requestedModel,
    resolvedModel: job.resolvedModel,
    requestedEffort: job.requestedEffort,
    profile: job.profile,
    followupOf: job.followupOf,
    runtimeVersion: job.runtimeVersion,
    templateDigest: job.templateDigest,
    workerTelemetry: job.workerTelemetry,
    runtimeCleanup: job.runtimeCleanup,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    durationMs: job.durationMs
  };
}

const [subcommand, ...rest] = process.argv.slice(2);
const { options, positionals } = parseArgs(rest);
const cwd = process.cwd();

function automaticGarbageCollection() {
  try {
    // Keep housekeeping off the launch critical path: at most 100 old artifact
    // trees are recursively inspected per invocation. Explicit `gc` is unbounded.
    return collectGarbage(cwd, { maxArtifactScans: 100 });
  } catch {
    // Launches must not fail because best-effort cleanup encountered a transient
    // filesystem or git error. The explicit `gc` command reports those details.
    return null;
  }
}

// `version` / `--version` — confirm which build is actually running.
if (subcommand === "version" || subcommand === "--version" || options.version) {
  const info = { name: "agent-collaboration", version: version(), runtimePath: fileURLToPath(import.meta.url), stateDir: resolveStateDir(cwd) };
  out(info, options, `agent-collaboration v${version()}\nruntime ${info.runtimePath}\nstate   ${info.stateDir}`);
  process.exit(0);
}

switch (subcommand) {
  case "setup": {
    if (options["retention-days"] !== undefined) {
      const days = Number(options["retention-days"]);
      if (!Number.isFinite(days) || days < 0) fail("setup: --retention-days must be a non-negative number (0 disables artifact expiry)");
    }
    if (options.gate || options.sandbox || options["retention-days"] !== undefined) {
      const state = loadState(cwd);
      if (options.gate) {
        state.config.stopReviewGate = options.gate === "on";
      }
      if (options.sandbox) {
        state.config.sandbox = options.sandbox === "on";
      }
      if (options["retention-days"] !== undefined) {
        state.config.artifactRetentionDays = Number(options["retention-days"]);
      }
      saveState(cwd, state);
    }
    automaticGarbageCollection();
    const rows = runSetup();
    const hint =
      "\nTip: when driving from a sandboxed harness (e.g. Codex), run the companion " +
      "with escalated/network-enabled permissions — it spawns a worker that calls an " +
      "external API, which a default sandbox will block.";
    out(rows, options, `agent-collaboration v${version()}\n\n` + renderSetup(rows) + "\n" + hint);
    break;
  }

  case "delegate":
  case "review":
  case "adversarial-review": {
    automaticGarbageCollection();
    const { driver, source: driverSource } = resolveDriver(options);
    const worker = options.worker;
    // Dual review (`--workers a,b`) has no single --worker; delegate still requires one.
    if (!worker && !(options.workers && subcommand !== "delegate")) {
      fail(`${subcommand}: --worker <name> is required (or --workers a,b for dual review)`);
    }
    const role = options.role || (subcommand === "delegate" ? "worker" : "reviewer");
    const kind = subcommand === "delegate" ? undefined : subcommand; // review | adversarial-review
    const brief = positionals.join(" ");
    if (!brief) fail(`${subcommand}: a brief is required`);

    // Take the native (same-harness) path ONLY when the driver is authoritatively
    // known (explicit --driver or AGENT_COLLAB_DRIVER). A guessed/fallback driver
    // must never turn a real cross-harness delegation into a "use your own
    // subagent" no-op — the Codex/agy raw-CLI footgun.
    const route = worker ? decideRoute({ driver, worker }) : null;
    if (route && route.mode === "native" && isAuthoritativeDriver(driverSource)) {
      out({ mode: "native", harness: route.harness, instruction: route.instruction }, options);
      break;
    }

    const timeoutMs = options.timeout ? Number(options.timeout) * 1000 : undefined;
    const profile = options.profile;

    // Dual/multi review: `--workers a,b` fans the SAME brief out to each worker
    // (sequentially; NO auto-fallback per leg — a fallback could collapse the
    // cross-family diversity dual review exists for), then merges the artifacts:
    // agreements deduped, unique findings tagged per reviewer, worst-of verdict.
    if (options.workers && kind) {
      if (options.background) fail(`${subcommand}: --workers (dual review) does not support --background — legs run synchronously`);
      const workers = String(options.workers).split(",").map((s) => s.trim()).filter(Boolean);
      if (workers.length < 2) fail(`${subcommand}: --workers needs >=2 comma-separated harnesses`);
      const legs = workers.map((w) => ({
        worker: w,
        result: runWithFallback(cwd, {
          driver, worker: w, role, brief, kind, focus: options.focus, surface: options.surface, timeoutMs, profile,
          fallbackKinds: new Set()
        })
      }));
      const merged = mergeReviews(legs);
      const res = {
        dual: true,
        workers,
        legs: legs.map((l) => ({
          jobId: l.result.jobId, worker: l.result.worker, status: l.result.status,
          resultValid: l.result.resultValid, artifactDir: l.result.artifactDir
        })),
        merged
      };
      out(res, options,
        `dual review — ${merged.verdict}\n${merged.summary}\n` +
        legs.map((l) => `  ${l.worker}: ${l.result.status} — ${l.result.jobId}`).join("\n"));
      break;
    }

    // Async path: spawn a detached worker and return immediately. Poll with
    // `status <jobId> --wait`, read with `result`, stop with `cancel`. Single
    // worker (no auto-fallback — that's the synchronous path).
    if (options.background) {
      const res = launchBackground(cwd, { driver, worker, role, brief, kind, focus: options.focus, surface: options.surface, timeoutMs, profile });
      out(res, options, `${res.status} (background) — ${res.worker} — ${res.jobId}\nPoll: status ${res.jobId} --wait`);
      break;
    }

    // Auto-fallback policy: by default fall back on transient capacity problems
    // (rate-limit, timeout); auth surfaces. Tune via AGENT_COLLAB_FALLBACK
    // (off|on|comma-list); --no-fallback forces a single worker.
    const fallbackKinds = options["no-fallback"] ? new Set() : resolveFallbackKinds();
    const res = runWithFallback(cwd, { driver, worker, role, brief, kind, focus: options.focus, surface: options.surface, timeoutMs, profile, fallbackKinds });
    if (options.apply && res.status === "completed" && role === "worker") {
      res.applied = applyResult(cwd, res.jobId);
    }
    const human =
      `${res.status} — ${res.worker} — ${res.jobId}\nartifacts: ${res.artifactDir}` +
      (res.note ? `\n${res.note}` : "");
    out(res, options, human);
    if (res.status !== "completed") process.exitCode = 2;
    break;
  }

  case "review-followup": {
    automaticGarbageCollection();
    const priorId = options.job;
    if (!priorId) fail("review-followup: --job <prior-job-id> is required");
    const prior = getJob(cwd, priorId);
    if (!prior) fail(`review-followup: unknown job ${priorId}`);
    if (prior.role !== "reviewer") fail(`review-followup: ${priorId} was not a review job`);
    if (prior.status !== "completed") fail(`review-followup: ${priorId} is not a completed review (status=${prior.status})`);
    const worker = options.worker || prior.worker;
    const { driver } = resolveDriver(options);
    const brief = positionals.join(" ");
    if (!brief) fail("review-followup: provide the focused follow-up diff or context");
    let priorArtifact = null;
    let priorReport = "";
    try {
      priorArtifact = JSON.parse(fs.readFileSync(path.join(prior.artifactDir, "outputs", `${prior.worker}.json`), "utf8"));
    } catch { /* the saved report may have been prose-only */ }
    try {
      priorReport = fs.readFileSync(path.join(prior.artifactDir, "reports", `${prior.worker}.md`), "utf8").trim();
    } catch { /* structured artifacts do not require a prose report */ }
    const usableArtifact = prior.resultValid === true && priorArtifact ? priorArtifact : null;
    if (!usableArtifact && !priorReport) {
      fail(`review-followup: ${priorId} has neither a valid structured artifact nor a saved prose report`);
    }
    const focus = [
      `Focused re-review of prior job ${priorId}.`,
      "Verify whether its findings are resolved and report only regressions caused by this follow-up; do not repeat full discovery.",
      usableArtifact
        ? `Prior review artifact: ${JSON.stringify(usableArtifact)}`
        : `Prior prose review:\n${priorReport}`,
      options.focus || ""
    ].filter(Boolean).join("\n");
    const timeoutMs = options.timeout ? Number(options.timeout) * 1000 : undefined;
    const res = runWithFallback(cwd, {
      driver, worker, role: "reviewer", kind: "review", brief, focus,
      surface: options.surface, profile: options.profile, timeoutMs,
      followupOf: priorId,
      fallbackKinds: options["no-fallback"] ? new Set() : resolveFallbackKinds()
    });
    out(res, options, `${res.status} — focused follow-up to ${priorId} — ${res.worker} — ${res.jobId}\nartifacts: ${res.artifactDir}`);
    if (res.status !== "completed") process.exitCode = 2;
    break;
  }

  case "doctor": {
    const live = !!options.live;
    const workers = options.workers
      ? options.workers.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const report = runDoctor(cwd, { live, workers });
    const human = [
      `doctor: ${report.ok ? "PASS" : "FAIL"}${live ? " (live)" : ""}`,
      ...report.checks.map((c) => `  ${c.warn ? "⚠" : c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`),
      live ? "" : "Run with --live to exercise each worker against a throwaway repo (spends model usage)."
    ]
      .filter(Boolean)
      .join("\n");
    out(report, options, human);
    if (!report.ok) process.exitCode = 2;
    break;
  }

  case "recommend": {
    if (options.profiles) {
      out(MODEL_PROFILES, options, renderProfiles(MODEL_PROFILES));
      break;
    }
    const task = options.task || positionals[0];
    if (!task) fail("recommend: --task <type> is required (or pass it as the argument). Use --profiles to list model strengths.");
    const { driver } = resolveDriver(options);
    const available = runSetup().filter((r) => r.validWorker).map((r) => r.name);
    const rec = recommendWorker({ task, driver, available });
    out(rec, options, renderRecommendation(rec));
    break;
  }

  // Internal: the detached worker entrypoint launched by `--background`.
  case "run-job": {
    if (!options.job) fail("run-job: --job <id> is required");
    try {
      runJob(cwd, options.job);
    } catch (e) {
      fail(`run-job: ${e.message}`);
    }
    break;
  }

  case "status": {
    const id = positionals[0];
    if (id && options.latest) fail("status: pass a job id or --latest, not both");
    if (id || options.latest) {
      const selected = id ? getJob(cwd, id) : latestCreatedJob(filterJobs(listJobs(cwd), options));
      if (!selected) fail(`status: ${id ? "unknown job" : "no matching jobs"}`);
      const job = options.wait
        ? waitForJob(cwd, selected.id, { timeoutMs: options.timeout ? Number(options.timeout) * 1000 : undefined })
        : options.refresh
          ? refreshJobStatus(cwd, selected.id)
          : selected;
      const projected = withHealth(job);
      out(projected, options, renderJob(projected));
    } else {
      let jobs = sortJobsNewestFirst(filterJobs(listJobs(cwd), options));
      jobs = jobs.slice(0, options.recent ? Math.max(0, Number(options.recent) || 0) : 8);
      if (options.refresh) jobs = jobs.map((job) => refreshJobStatus(cwd, job.id));
      jobs = jobs.map(withHealth);
      out(jobs, options, renderJobList(jobs));
    }
    break;
  }

  case "result": {
    const id = positionals[0];
    if (id && options.latest) fail("result: pass a job id or --latest, not both");
    if (!id && !options.latest) fail("result: a job id or --latest is required");
    const selected = id ? getJob(cwd, id) : latestCreatedJob(filterJobs(listJobs(cwd), options));
    if (!selected) fail(`result: ${id ? "unknown job" : "no matching jobs"}`);
    const job = options.refresh ? refreshJobStatus(cwd, selected.id) : selected;
    const health = projectJobHealth(job);
    if (!isTerminalStatus(job.status)) {
      const pending = {
        ready: false,
        job: resultJobMetadata(job),
        health,
        waitCommand: `status ${job.id} --wait`
      };
      const human = [
        `result not ready — job ${job.id} is ${job.status}`,
        health?.healthy ? "health: live and within budget (not stalled)" : `health: ${health?.state ?? "unknown"}`,
        `wait: ${pending.waitCommand}`
      ].join("\n");
      out(pending, options, human);
      break;
    }
    const outputFile = path.join(job.artifactDir, "outputs", `${job.worker}.json`);
    const artifact = fs.existsSync(outputFile)
      ? JSON.parse(fs.readFileSync(outputFile, "utf8"))
      : { error: "no output artifact" };
    const reportFile = path.join(job.artifactDir, "reports", `${job.worker}.md`);
    const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : "";
    const envelope = { ready: true, job: resultJobMetadata(job), artifact, report };
    const warning = [job.note, job.breachWarning ? `breach warning: ${JSON.stringify(job.breachWarning)}` : null]
      .filter(Boolean)
      .join("\n");
    const human = `${warning ? `WARNING\n${warning}\n\n` : ""}${report}\n\n---\n${JSON.stringify(envelope, null, 2)}`;
    out(options["artifact-only"] ? artifact : envelope, options, options["artifact-only"] ? JSON.stringify(artifact, null, 2) : human);
    break;
  }

  case "apply": {
    const id = positionals[0];
    if (!id) fail("apply: a job id is required");
    const result = applyResult(cwd, id);
    let human = result.applied
      ? "patch applied to the working tree (unstaged; `git diff` to inspect, then commit). Pre-existing staged work is left untouched."
      : `not applied: ${result.error ?? result.stderr}`;
    if (result.applied) {
      if (result.paths?.length) human += `\nPaths: ${result.paths.join(", ")}`;
      if (result.stat) human += `\n${result.stat}`;
    }
    if (!result.applied) {
      const s = `${result.stderr ?? ""} ${result.error ?? ""}`;
      if (/does not match index|already exists in (the )?index|cannot read the current contents/i.test(s)) {
        human += "\nTip: a staged/partially-applied change for these files is in your git index. " +
          "Try `git reset` (and restore the files) to clean the index, then re-run apply.";
      } else if (/patch does not apply|conflict/i.test(s)) {
        human += "\nTip: the base moved under this patch. Inspect the patch and the target files; " +
          "resolve conflicts manually, or re-delegate against the current HEAD.";
      }
    }
    out(result, options, human);
    if (!result.applied) process.exitCode = 2;
    break;
  }

  case "gc": {
    let artifactRetentionDays;
    if (options["artifacts-older-than"] !== undefined) {
      artifactRetentionDays = Number(options["artifacts-older-than"]);
      if (!Number.isFinite(artifactRetentionDays) || artifactRetentionDays < 0) {
        fail("gc: --artifacts-older-than must be a non-negative number (0 disables artifact expiry)");
      }
    }
    const result = collectGarbage(cwd, {
      dryRun: !!options["dry-run"],
      includeUnapplied: !!options["include-unapplied"],
      artifactRetentionDays
    });
    const bytes = result.worktrees.bytesFreed + result.artifacts.bytesFreed;
    const human = [
      `${result.dryRun ? "would reclaim" : "reclaimed"} ${bytes} bytes`,
      `worktrees: ${result.worktrees.removed.length} removed, ${result.worktrees.reconciled.length} dead records reconciled, ${result.worktrees.skipped.length} preserved`,
      `artifacts: ${result.artifacts.removed.length} removed, ${result.artifacts.skipped.length} preserved`,
      result.artifacts.disabled ? "artifact retention is disabled" : `artifact retention: ${result.artifacts.retentionDays} days`,
      options["include-unapplied"] ? "WARNING: unapplied patches were included" : "unapplied patches were preserved"
    ].join("\n");
    out(result, options, human);
    break;
  }

  case "cancel": {
    const id = positionals[0];
    if (!id) fail("cancel: a job id is required");
    const job = getJob(cwd, id);
    if (!job) fail("cancel: unknown job");
    if (isTerminalStatus(job.status)) {
      const response = { cancelled: false, reason: `job is already ${job.status}`, job };
      out(response, options, `not cancelled: job ${id} is already ${job.status}`);
      process.exitCode = 2;
      break;
    }
    const health = projectJobHealth(job);
    if (!options.force && health?.healthy) {
      const response = {
        cancelled: false,
        reason: "job is healthy and within its configured idle and hard time budgets",
        job: resultJobMetadata(job),
        health,
        waitCommand: `status ${id} --wait`,
        forceCommand: `cancel ${id} --force`
      };
      out(
        response,
        options,
        `not cancelled: job ${id} is healthy and within budget (not stalled)\n` +
          `wait: ${response.waitCommand}\n` +
          `override only when cancellation is intentional: ${response.forceCommand}`
      );
      process.exitCode = 2;
      break;
    }
    if (job.pid && isPidAlive(job.pid)) {
      try {
        // A background job is its own process group (detached) — kill the whole
        // group so the worker subprocess dies too, not just the launcher.
        if (job.background) process.kill(-job.pid);
        else process.kill(job.pid);
      } catch {
        try {
          process.kill(job.pid);
        } catch {
          /* already gone */
        }
      }
    }
    const runtimeCleanup = cleanupWorkerRuntime(job.worker, job.workspace ?? cwd, job.artifactDir);
    const processExited = waitForPidExit(job.pid);
    let updated = updateJob(cwd, id, { status: "cancelled", runtimeCleanup });
    const worktreeCleanup = cleanupJobWorktree(cwd, updated);
    updated = updateJob(cwd, id, { processExited, worktreeCleanup });
    out(updated, options, `cancelled ${id}`);
    break;
  }

  default:
    fail(
      [
        "usage: agent-companion <command>",
        "  setup [--json] [--gate on|off] [--sandbox on|off] [--retention-days n]",
        "  doctor [--live] [--workers a,b] [--json]   self-check (config + readiness; --live runs review+isolation smoke)",
        "  recommend --task <type> [--driver <name>] [--json]   |   recommend --profiles",
        "  delegate --worker <name> [--driver <name>] [--role worker|reviewer] [--background] [--apply] [--timeout s] <brief>",
        "  review  --worker <name> | --workers a,b [--surface head|working-tree|diff] [--focus <text>] [--profile <name>] [--background] <diff/context>",
        "  adversarial-review --worker <name> | --workers a,b [--surface head|working-tree|diff] [--focus <text>] [--profile <name>] [--background] <diff/context>",
        "  review-followup --job <prior-id> [--worker <name>] [--surface head|working-tree|diff] <focused diff/context>",
        "  status [jobId|--latest] [--worker name] [--role role] [--refresh|--wait] [--timeout s] [--active] [--recent n] [--json]",
        "  result <jobId|--latest> [--worker name] [--role role] [--refresh] [--artifact-only] [--json]",
        "  apply  <jobId>",
        "  gc [--dry-run] [--artifacts-older-than days] [--include-unapplied] [--json]",
        "  cancel <jobId> [--force]"
      ].join("\n")
    );
}
