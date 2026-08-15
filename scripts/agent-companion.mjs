#!/usr/bin/env node
// agent-collaboration companion CLI. Generalized from codex-plugin-cc's
// codex-companion.mjs (Apache-2.0, Copyright 2026 OpenAI) into a harness-agnostic
// dispatcher. Slash commands are thin wrappers over these subcommands.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decideRoute, resolveDriver, isAuthoritativeDriver, runSetup, runWorkerSync, runWithFallback, resolveFallbackKinds, launchBackground, runJob, waitForJob, refreshJobStatus, applyResult, recommendWorker, cleanupWorkerRuntime } from "../core/dispatch.mjs";
import { registerPeer, registerSelf, heartbeatPeer, unregisterPeer, listPeers, listMachines, listMachineRecords, registerMachine, pickMachine, eligibleMachines, sendMessage, readInbox, ackInbox, resolveComputer, listRemoteInboxes } from "../core/peers.mjs";
import { listenPeersServer, peersHttp, collectMachineProbes } from "../core/peers-serve.mjs";
import { deliverInbox } from "../core/peer-deliver.mjs";
import { assignTask, waitForReply } from "../core/peer-assign.mjs";
import { handleAssignedWork } from "../core/peer-receive.mjs";
import { replyToAssign } from "../core/peer-reply.mjs";
import { tickPresence, runPresenceLoop } from "../core/peer-presence.mjs";
import { runDoctor } from "../core/doctor.mjs";
import { mergeReviews } from "../core/merge-reviews.mjs";
import { version } from "../core/version.mjs";
import { listJobs, getJob, updateJob, sortJobsNewestFirst, loadState, saveState, resolveStateDir, isTerminalStatus } from "../core/state.mjs";
import { isPidAlive, projectJobHealth } from "../core/heartbeat.mjs";
import { renderSetup, renderJob, renderJobList, renderRecommendation, renderProfiles } from "../core/render.mjs";
import { MODEL_PROFILES } from "../core/model-profiles.mjs";
import { cleanupJobWorktree, collectGarbage, waitForPidExit } from "../core/gc.mjs";
import { resolveWorkerRef } from "../core/instances.mjs";

const VALUE_FLAGS = new Set(["worker", "workers", "role", "driver", "base", "timeout", "gate", "sandbox", "focus", "surface", "task", "job", "recent", "retention-days", "artifacts-older-than", "name", "to", "from", "harness", "hint-harness", "reply-address", "session-id", "reach", "pid", "listen", "token", "pair", "limit", "turn-state", "computer", "url", "interval-ms", "refuse", "to-computer", "wait-seconds"]);
const BOOL_FLAGS = new Set(["json", "apply", "wait", "background", "profiles", "no-fallback", "live", "active", "latest", "refresh", "artifact-only", "force", "dry-run", "include-unapplied", "ack", "once", "consume", "no-consume"]);

function optionalComputer(options) {
  if (options.computer != null && options.computer !== "") {
    return resolveComputer({ computer: options.computer });
  }
  if (process.env.AGENT_COLLAB_PEERS_COMPUTER) return resolveComputer({});
  return undefined;
}

function parseArgs(tokens) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--") {
      positionals.push(...tokens.slice(i + 1));
      break;
    }
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
    (!options.worker ||
      job.worker === options.worker ||
      job.harness === options.worker ||
      job.instance === options.worker) &&
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
    const rows = runSetup(undefined, { workspace: cwd });
    const hint =
      "\nTip: when driving from a sandboxed harness (e.g. Codex), run the companion " +
      "with escalated/network-enabled permissions — it spawns a worker that calls an " +
      "external API, which a default sandbox will block.\n" +
      "Instance aliases (multi-account): ~/.agent-collaboration/config.json — see README.";
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
    const route = worker ? decideRoute({ driver, worker, workspace: cwd }) : null;
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
      const harnesses = [];
      for (const w of workers) {
        let ref;
        try {
          ref = resolveWorkerRef(w, { workspace: cwd });
        } catch (err) {
          fail(`${subcommand}: ${err.message}`);
        }
        if (harnesses.includes(ref.harness)) {
          fail(
            `${subcommand}: --workers entries must be different harness families ` +
              `(got multiple resolving to "${ref.harness}")`
          );
        }
        harnesses.push(ref.harness);
      }
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

  case "peers": {
    const verb = positionals[0];
    if (!verb) {
      fail(
        "usage: agent-companion peers <self|heartbeat|presence|register|unregister|list|machine|machines|eligible|pick|assign|send|inbox|deliver|consume|reply|serve>\n" +
          "  peers self --harness <h> [--name <name>] [--session-id <id>] [--pid <n>] [--computer <label>] [--json]\n" +
          "  peers heartbeat --name <name> [--pid <n>] [--turn-state idle|busy] [--computer <label>] [--harness <h>] [--json]\n" +
          "  peers presence --computer <label> --harness <h> [--turn-state idle|busy] [--name <name>] [--session-id <id>] [--interval-ms n] [--once] [--consume|--no-consume] [--json]\n" +
          "  peers register --name <name> [--harness <h>] [--reply-address <addr>] [--session-id <id>] [--pid <n>] [--reach local|cross-machine] [--computer <label>] [--pair <secret>] [--json]\n" +
          "  peers unregister --name <name> [--json]\n" +
          "  peers list [--json]\n" +
          "  peers machine --computer <label> [--url http://100.x:8744]\n" +
          "  peers machines [--json]\n" +
          "  peers eligible [--json]\n" +
          "  peers pick [--json]\n" +
          "  peers assign --from <name> [--to <session>] [--to-computer label] [--hint-harness h] [--wait-seconds n] <text>\n" +
          "  peers send --to <name> --from <name> <text>\n" +
          "  peers inbox --name <name> [--ack] [--json]\n" +
          "  peers deliver --name <name> [--limit n] [--json]\n" +
          "  peers consume --name <name> [--refuse <reason>] [--json]\n" +
          "  peers reply --from <name> --to <name> <text>\n" +
          "  peers serve [--listen host:port] [--pair <secret>] [--computer <label>]"
      );
    }
    try {
      if (verb === "self") {
        if (!options.harness) fail("peers self: --harness is required");
        const peer = registerSelf({
          harness: options.harness,
          name: options.name,
          sessionId: options["session-id"],
          replyAddress: options["reply-address"],
          pid: options.pid,
          computer: optionalComputer(options)
        });
        out(
          peer,
          options,
          `self ${peer.name} (${peer.harness}) ${peer.computer ?? "-"} pid=${peer.pid ?? "-"} ${peer.status}`
        );
        break;
      }
      if (verb === "heartbeat") {
        if (!options.name) fail("peers heartbeat: --name is required");
        const peer = heartbeatPeer({
          name: options.name,
          pid: options.pid,
          turnState: options["turn-state"],
          computer: optionalComputer(options),
          harness: options.harness
        });
        out(
          peer,
          options,
          `heartbeat ${peer.name} ${peer.status} turnState=${peer.turnState ?? "-"} harness=${peer.harness ?? "-"} computer=${peer.computer ?? "-"}`
        );
        break;
      }
      if (verb === "presence") {
        if (!options.harness) fail("peers presence: --harness is required");
        const computer = optionalComputer(options);
        if (!computer) fail("peers presence: --computer is required");
        const consume = options["no-consume"] ? false : options.once ? Boolean(options.consume) : options.consume !== false;
        const presence = {
          name: options.name,
          harness: options.harness,
          computer,
          turnState: options["turn-state"] || "idle",
          sessionId: options["session-id"],
          pid: options.pid,
          persistPid: !options.once
        };
        if (options.once) {
          const peer = tickPresence(presence);
          if (consume) {
            const work = handleAssignedWork({ name: peer.name, refuse: options.refuse });
            out(work.consumed ? work : peer, options, work.consumed
              ? `consumed ${work.message?.id ?? "-"} reply=${work.reply?.id ?? "-"} turnState=${work.turnState}`
              : `presence ${peer.name} ${peer.harness} ${peer.computer} turnState=${peer.turnState ?? "-"}`);
          } else {
            out(
              peer,
              options,
              `presence ${peer.name} ${peer.harness} ${peer.computer} turnState=${peer.turnState ?? "-"}`
            );
          }
          break;
        }
        const ac = new AbortController();
        const stop = () => ac.abort();
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        process.stdout.write(
          JSON.stringify({
            presence: true,
            name: options.name || options.harness,
            harness: options.harness,
            computer,
            turnState: presence.turnState,
            intervalMs: Number(options["interval-ms"]) || undefined,
            consume
          }) + "\n"
        );
        await runPresenceLoop({
          ...presence,
          intervalMs: options["interval-ms"],
          consume,
          signal: ac.signal,
          shouldContinue: () => !ac.signal.aborted
        });
        break;
      }
      if (verb === "register") {
        if (!options.name) fail("peers register: --name is required");
        const url = process.env.AGENT_COLLAB_PEERS_URL;
        const peer = url
          ? await peersHttp(url, {
              method: "POST",
              path: "/peers/register",
              token: options.pair || process.env.AGENT_COLLAB_PEERS_PAIR,
              body: {
                name: options.name,
                harness: options.harness,
                sessionId: options["session-id"],
                replyAddress: options["reply-address"],
                reach: options.reach,
                pid: options.pid,
                computer: optionalComputer(options)
              }
            })
          : registerPeer({
              name: options.name,
              harness: options.harness,
              sessionId: options["session-id"],
              replyAddress: options["reply-address"],
              reach: options.reach,
              pid: options.pid,
              computer: optionalComputer(options)
            });
        out(
          peer,
          options,
          `registered ${peer.name}${peer.harness ? ` (${peer.harness})` : ""} ${peer.computer ?? "-"} ${peer.reach} ${peer.status}`
        );
        break;
      }
      if (verb === "unregister") {
        if (!options.name) fail("peers unregister: --name is required");
        const result = unregisterPeer({ name: options.name });
        out(result, options, `unregistered ${result.unregistered}`);
        break;
      }
      if (verb === "list") {
        const url = process.env.AGENT_COLLAB_PEERS_URL;
        const peers = url
          ? (
              await peersHttp(url, {
                path: "/peers/list",
                token: options.pair || process.env.AGENT_COLLAB_PEERS_PAIR
              })
            ).peers
          : listPeers();
        const human = peers.length
          ? peers
              .map((p) => `${p.name}\t${p.harness ?? "-"}\t${p.computer ?? "-"}\t${p.reach}\t${p.status}`)
              .join("\n")
          : "(no peers)";
        out(peers, options, human);
        break;
      }
      if (verb === "machine") {
        const computer = optionalComputer(options);
        if (!computer) fail("peers machine: --computer is required");
        const rec = registerMachine({ computer, url: options.url });
        out(rec, options, `machine ${rec.computer}\t${rec.url ?? "-"}`);
        break;
      }
      if (verb === "machines") {
        const pair = options.pair || process.env.AGENT_COLLAB_PEERS_PAIR;
        const probes = await collectMachineProbes(listMachineRecords(), { pair });
        const rows = listMachines({ probes });
        const human = rows.length
          ? rows
              .map((m) => {
                const sess = m.session
                  ? `${m.session.name}:${m.session.turnState ?? "unknown"}`
                  : "-";
                return `${m.computer}\t${m.available ? "available" : "unavailable"}\t${m.activity}\t${m.harness ?? "-"}\t${sess}\t${m.reason}`;
              })
              .join("\n")
          : "(no machines)";
        out(rows, options, human);
        break;
      }
      if (verb === "eligible" || verb === "pick" || verb === "assign") {
        const pair = options.pair || process.env.AGENT_COLLAB_PEERS_PAIR;
        const probes = await collectMachineProbes(listMachineRecords(), { pair });
        const rows = listMachines({ probes });
        if (verb === "eligible") {
          const eligible = eligibleMachines(rows, { from: options.from, to: options.to });
          const human = eligible.length
            ? eligible
                .map((m) => `${m.computer}\t${m.activity}\t${m.session.name}`)
                .join("\n")
            : "(none eligible)";
          out(eligible, options, human);
          break;
        }
        if (verb === "pick") {
          const picked = pickMachine(rows, { from: options.from, to: options.to });
          if (!picked) {
            out({ picked: null, machines: rows }, options, "(no eligible machine)");
            process.exitCode = 2;
            break;
          }
          out(picked, options, `${picked.computer}\t${picked.activity}\t${picked.session.name}`);
          break;
        }
        if (!options.from) fail("peers assign: --from is required");
        const text = positionals.slice(1).join(" ");
        if (!text) fail("peers assign: a text payload is required");
        const result = await assignTask({
          from: options.from,
          text,
          pair,
          harness: options.harness,
          computer: optionalComputer(options),
          toComputer: options["to-computer"],
          machines: rows,
          probes,
          hintHarness: options["hint-harness"],
          to: options.to
        });
        let payload = result;
        if (options["wait-seconds"]) {
          const reply = await waitForReply({
            name: result.senderName,
            url: result.remote ? result.machine.url : null,
            token: result.senderToken,
            from: result.to,
            assignId: result.message.id,
            afterCreatedAt: result.message.createdAt,
            timeoutMs: Number(options["wait-seconds"]) * 1000
          });
          payload = { ...result, reply };
        }
        const shown = { ...payload };
        if (!options.json) delete shown.senderToken;
        out(
          shown,
          options,
          payload.reply
            ? `assigned ${result.message.id} to ${result.to} on ${result.machine.computer}; reply ${payload.reply.id} from ${payload.reply.from}`
            : `assigned ${result.message.id} to ${result.to} on ${result.machine.computer} (${result.machine.activity})`
        );
        break;
      }
      if (verb === "send") {
        if (!options.to) fail("peers send: --to is required");
        if (!options.from) fail("peers send: --from is required");
        const text = positionals.slice(1).join(" ");
        if (!text) fail("peers send: a text payload is required");
        const url = process.env.AGENT_COLLAB_PEERS_URL;
        const msg = url
          ? await peersHttp(url, {
              method: "POST",
              path: "/peers/send",
              token: options.token || process.env.AGENT_COLLAB_PEERS_TOKEN,
              body: { to: options.to, from: options.from, text }
            })
          : sendMessage({ to: options.to, from: options.from, text });
        out(msg, options, `sent ${msg.id} to ${msg.to} from ${msg.from}`);
        break;
      }
      if (verb === "inbox") {
        if (!options.name) fail("peers inbox: --name is required");
        const url = process.env.AGENT_COLLAB_PEERS_URL;
        let payload;
        if (url) {
          const q = new URLSearchParams({ name: options.name });
          if (options.ack) q.set("ack", "1");
          payload = await peersHttp(url, {
            path: `/peers/inbox?${q}`,
            token: options.token || process.env.AGENT_COLLAB_PEERS_TOKEN
          });
        } else {
          const local = readInbox({ name: options.name });
          if (local.length) {
            if (options.ack) ackInbox({ name: options.name, ids: local.map((m) => m.id) });
            payload = { name: options.name, messages: local, acked: !!options.ack };
          } else {
            const remotes = listRemoteInboxes(options.name);
            const messages = [];
            for (const c of remotes) {
              const q = new URLSearchParams({ name: c.name });
              if (options.ack) q.set("ack", "1");
              const box = await peersHttp(c.url, {
                path: `/peers/inbox?${q}`,
                token: options.token || c.token
              });
              messages.push(...(box.messages || []));
            }
            payload = { name: options.name, messages, acked: !!options.ack, remote: remotes.length > 0 };
          }
        }
        const human = payload.messages.length
          ? payload.messages.map((m) => `[${m.from}] ${m.text}`).join("\n")
          : "(empty inbox)";
        out(payload, options, human);
        break;
      }
      if (verb === "deliver") {
        if (!options.name) fail("peers deliver: --name is required");
        // send enqueues only; deliver is the separate consumer. Mailbox write
        // lock is never held across the Cursor spawn.
        const payload = deliverInbox({
          name: options.name,
          limit: options.limit ? Number(options.limit) : 1
        });
        const human = payload.results.length
          ? payload.results
              .map((r) => `${r.messageId}\tdelivered=${r.delivered}\tqueued=${r.queued}\t${r.reason || ""}`)
              .join("\n")
          : "(empty inbox)";
        out(payload, options, human);
        break;
      }
      if (verb === "consume") {
        if (!options.name) fail("peers consume: --name is required");
        const payload = handleAssignedWork({
          name: options.name,
          refuse: options.refuse
        });
        out(
          payload,
          options,
          payload.consumed
            ? `consumed ${payload.message?.id ?? "-"} reply=${payload.reply?.id ?? "-"} turnState=${payload.turnState}`
            : `(empty inbox)`
        );
        break;
      }
      if (verb === "reply") {
        if (!options.from) fail("peers reply: --from is required");
        if (!options.to) fail("peers reply: --to is required");
        const text = positionals.slice(1).join(" ");
        if (!text) fail("peers reply: a text payload is required");
        const msg = replyToAssign({ from: options.from, to: options.to, text });
        out(msg, options, `replied ${msg.id} to ${msg.to} from ${msg.from}`);
        break;
      }
      if (verb === "serve") {
        const listen = options.listen || "127.0.0.1:0";
        const [host, port] = listen.includes(":") ? listen.split(":") : ["127.0.0.1", listen];
        const { url, pairRequired, computer } = await listenPeersServer({
          host,
          port: Number(port) || 0,
          pair: options.pair,
          computer: optionalComputer(options)
        });
        process.stdout.write(
          JSON.stringify({ url, host, listen: url, pairRequired, computer }, null, 2) + "\n"
        );
        await new Promise(() => {});
        break;
      }
      fail(`peers: unknown verb ${verb}`);
    } catch (e) {
      fail(`peers ${verb}: ${e.message}`);
    }
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
    const runtimeCleanup = cleanupWorkerRuntime(job.worker, job.workspace ?? cwd, job.artifactDir, {
      workerRef: job.harness
        ? {
            label: job.worker,
            harness: job.harness,
            instance: job.instance ?? null,
            overlay: {},
            hasOverlay: false
          }
        : undefined
    });
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
        "  delegate --worker <name|instance> [--driver <name>] [--role worker|reviewer] [--background] [--apply] [--timeout s] <brief>",
        "  review  --worker <name|instance> | --workers a,b [--surface head|working-tree|diff] [--focus <text>] [--profile <name>] [--background] <diff/context>",
        "  adversarial-review --worker <name|instance> | --workers a,b [--surface head|working-tree|diff] [--focus <text>] [--profile <name>] [--background] <diff/context>",
        "  review-followup --job <prior-id> [--worker <name>] [--surface head|working-tree|diff] <focused diff/context>",
        "  status [jobId|--latest] [--worker name] [--role role] [--refresh|--wait] [--timeout s] [--active] [--recent n] [--json]",
        "  result <jobId|--latest> [--worker name] [--role role] [--refresh] [--artifact-only] [--json]",
        "  apply  <jobId>",
        "  gc [--dry-run] [--artifacts-older-than days] [--include-unapplied] [--json]",
        "  cancel <jobId> [--force]",
        "  peers self --harness <h> [--name n] [--session-id id] [--pid n] [--computer label]",
        "  peers heartbeat --name <name> [--pid n] [--turn-state idle|busy] [--computer label] [--harness h]",
        "  peers presence --computer label --harness h [--turn-state idle|busy] [--name n] [--session-id id] [--interval-ms n] [--once] [--consume|--no-consume]",
        "  peers register --name <name> [--harness h] [--reply-address addr] [--session-id id] [--pid n] [--reach local|cross-machine] [--computer label]",
        "  peers unregister --name <name>",
        "  peers list [--json]",
        "  peers machine --computer label [--url http://100.x:port]",
        "  peers machines [--json]",
        "  peers eligible [--json]",
        "  peers pick [--json]",
        "  peers assign --from <name> [--to <session>] [--to-computer label] [--hint-harness h] [--wait-seconds n] <text>",
        "  peers send --to <name> --from <name> <text>",
        "  peers inbox --name <name> [--ack] [--json]",
        "  peers deliver --name <name> [--limit n] [--json]",
        "  peers consume --name <name> [--refuse reason] [--json]",
        "  peers reply --from <name> --to <name> <text>",
        "  peers serve [--listen 127.0.0.1:port] [--pair secret] [--computer label]"
      ].join("\n")
    );
}
