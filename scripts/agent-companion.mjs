#!/usr/bin/env node
// agent-collaboration companion CLI. Generalized from codex-plugin-cc's
// codex-companion.mjs (Apache-2.0, Copyright 2026 OpenAI) into a harness-agnostic
// dispatcher. Slash commands are thin wrappers over these subcommands.
import fs from "node:fs";
import path from "node:path";

import { decideRoute, resolveDriver, isAuthoritativeDriver, runSetup, runWorkerSync, runWithFallback, applyResult, recommendWorker } from "../core/dispatch.mjs";
import { listJobs, getJob, updateJob, sortJobsNewestFirst, loadState, saveState } from "../core/state.mjs";
import { isPidAlive } from "../core/heartbeat.mjs";
import { renderSetup, renderJob, renderJobList, renderRecommendation, renderProfiles } from "../core/render.mjs";
import { MODEL_PROFILES } from "../core/model-profiles.mjs";

const VALUE_FLAGS = new Set(["worker", "role", "driver", "base", "timeout", "gate", "sandbox", "focus", "task"]);
const BOOL_FLAGS = new Set(["json", "apply", "wait", "background", "profiles", "no-fallback"]);

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

const [subcommand, ...rest] = process.argv.slice(2);
const { options, positionals } = parseArgs(rest);
const cwd = process.cwd();

switch (subcommand) {
  case "setup": {
    if (options.gate || options.sandbox) {
      const state = loadState(cwd);
      if (options.gate) {
        state.config.stopReviewGate = options.gate === "on";
      }
      if (options.sandbox) {
        state.config.sandbox = options.sandbox === "on";
      }
      saveState(cwd, state);
    }
    const rows = runSetup();
    const hint =
      "\nTip: when driving from a sandboxed harness (e.g. Codex), run the companion " +
      "with escalated/network-enabled permissions — it spawns a worker that calls an " +
      "external API, which a default sandbox will block.";
    out(rows, options, renderSetup(rows) + "\n" + hint);
    break;
  }

  case "delegate":
  case "review":
  case "adversarial-review": {
    const { driver, source: driverSource } = resolveDriver(options);
    const worker = options.worker;
    if (!worker) fail(`${subcommand}: --worker <name> is required`);
    const role = options.role || (subcommand === "delegate" ? "worker" : "reviewer");
    const kind = subcommand === "delegate" ? undefined : subcommand; // review | adversarial-review
    const brief = positionals.join(" ");
    if (!brief) fail(`${subcommand}: a brief is required`);

    // Take the native (same-harness) path ONLY when the driver is authoritatively
    // known (explicit --driver or AGENT_COLLAB_DRIVER). A guessed/fallback driver
    // must never turn a real cross-harness delegation into a "use your own
    // subagent" no-op — the Codex/agy raw-CLI footgun.
    const route = decideRoute({ driver, worker });
    if (route.mode === "native" && isAuthoritativeDriver(driverSource)) {
      out({ mode: "native", harness: route.harness, instruction: route.instruction }, options);
      break;
    }

    const timeoutMs = options.timeout ? Number(options.timeout) * 1000 : undefined;
    // Auto-fallback on a subscription/rate limit (or auth) is ON by default; a
    // genuine task failure never triggers it. Disable with --no-fallback or
    // AGENT_COLLAB_FALLBACK=off (single worker, surface the limit).
    const fallback = !options["no-fallback"] && process.env.AGENT_COLLAB_FALLBACK !== "off";
    const res = runWithFallback(cwd, { driver, worker, role, brief, kind, focus: options.focus, timeoutMs, fallback });
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

  case "status": {
    const id = positionals[0];
    if (id) {
      const job = getJob(cwd, id);
      out(job ?? { error: "unknown job" }, options, renderJob(job));
    } else {
      const jobs = sortJobsNewestFirst(listJobs(cwd)).slice(0, 8);
      out(jobs, options, renderJobList(jobs));
    }
    break;
  }

  case "result": {
    const id = positionals[0];
    if (!id) fail("result: a job id is required");
    const job = getJob(cwd, id);
    if (!job) fail("result: unknown job");
    const outputFile = path.join(job.artifactDir, "outputs", `${job.worker}.json`);
    const artifact = fs.existsSync(outputFile)
      ? JSON.parse(fs.readFileSync(outputFile, "utf8"))
      : { error: "no output artifact" };
    const reportFile = path.join(job.artifactDir, "reports", `${job.worker}.md`);
    const report = fs.existsSync(reportFile) ? fs.readFileSync(reportFile, "utf8") : "";
    out(artifact, options, `${report}\n\n---\n${JSON.stringify(artifact, null, 2)}`);
    break;
  }

  case "apply": {
    const id = positionals[0];
    if (!id) fail("apply: a job id is required");
    const result = applyResult(cwd, id);
    out(result, options, result.applied ? "patch applied" : `not applied: ${result.error ?? result.stderr}`);
    if (!result.applied) process.exitCode = 2;
    break;
  }

  case "cancel": {
    const id = positionals[0];
    if (!id) fail("cancel: a job id is required");
    const job = getJob(cwd, id);
    if (!job) fail("cancel: unknown job");
    if (job.pid && isPidAlive(job.pid)) {
      try {
        process.kill(job.pid);
      } catch {
        /* already gone */
      }
    }
    const updated = updateJob(cwd, id, { status: "cancelled" });
    out(updated, options, `cancelled ${id}`);
    break;
  }

  default:
    fail(
      [
        "usage: agent-companion <command>",
        "  setup [--json] [--gate on|off] [--sandbox on|off]",
        "  recommend --task <type> [--driver <name>] [--json]   |   recommend --profiles",
        "  delegate --worker <name> [--driver <name>] [--role worker|reviewer] [--apply] [--timeout s] <brief>",
        "  review  --worker <name> [--driver <name>] [--focus <text>] <diff/context>",
        "  adversarial-review --worker <name> [--focus <text>] <diff/context>",
        "  status [jobId] [--json]",
        "  result <jobId> [--json]",
        "  apply  <jobId>",
        "  cancel <jobId>"
      ].join("\n")
    );
}
