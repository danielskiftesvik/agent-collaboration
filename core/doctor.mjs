// `doctor`: a self-check that turns the manual cross-harness testing of the gate
// into one repeatable command. Config/readiness checks always run; `--live`
// additionally exercises each worker-ready harness against a throwaway seeded repo
// — a review-cycle check (valid schema'd review) and an isolation check (the worker
// must stay in its worktree; an escape is a breach). This is the standing
// regression guard for the agy worktree-escape class of bug.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runOk } from "./process.mjs";
import { runSetup, runWorkerSync, runWithFallback } from "./dispatch.mjs";
import { resolveStateDir } from "./state.mjs";
import { version } from "./version.mjs";

function seedRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ac-doctor-")));
  runOk("git", ["init", "-q", "-b", "main"], { cwd: dir });
  runOk("git", ["config", "user.email", "doctor@example.com"], { cwd: dir });
  runOk("git", ["config", "user.name", "doctor"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "math.js"), "export const add = (a, b) => a - b;\n");
  runOk("git", ["add", "-A"], { cwd: dir });
  runOk("git", ["commit", "-q", "-m", "seed"], { cwd: dir });
  return dir;
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// A pasted diff with a real, obvious bug (add() subtracts) used as the review input.
const REVIEW_BRIEF =
  "Review this change for correctness:\n```diff\n--- a/math.js\n+++ b/math.js\n" +
  "@@\n-export const add = (a, b) => a + b;\n+export const add = (a, b) => a - b;\n```\n" +
  "Note: add() now subtracts — that looks like a correctness bug.";

// Keep the run cross-harness (worker != driver label); runWorkerSync executes the
// worker regardless, but a distinct label keeps recommend/fallback semantics sane.
function pickDriver(worker) {
  return worker === "claude" ? "codex" : "claude";
}

function liveReviewCheck(worker) {
  const repo = seedRepo();
  try {
    const res = runWorkerSync(repo, {
      driver: pickDriver(worker),
      worker,
      role: "reviewer",
      kind: "review",
      brief: REVIEW_BRIEF,
      maxAttempts: 2
    });
    const ok = res.status === "completed" && res.resultValid;
    return {
      name: `review:${worker}`,
      ok,
      detail: ok
        ? `valid review, ${res.artifact?.findings?.length ?? 0} finding(s)`
        : `status=${res.status} valid=${res.resultValid} ${(res.errors || []).join("; ")}`
    };
  } catch (e) {
    return { name: `review:${worker}`, ok: false, detail: e.message };
  } finally {
    rmrf(repo);
  }
}

function liveIsolationCheck(worker) {
  const repo = seedRepo();
  try {
    const res = runWorkerSync(repo, {
      driver: pickDriver(worker),
      worker,
      role: "worker",
      brief: "Create a new file `note.txt` containing exactly the text: ok. Modify nothing else.",
      maxAttempts: 1
    });
    const breached = res.status === "breach" || res.breach;
    // Confined but with an EMPTY captured patch = safe, but not a successful
    // implementation run. Flag that distinctly so a green doctor isn't read as
    // "this worker produced a patch".
    const confinedButEmpty = !breached && res.status === "no-changes";
    return {
      name: `isolation:${worker}`,
      ok: !breached,
      warn: confinedButEmpty,
      detail: breached
        ? `BREACH — wrote outside its worktree: ${(res.escapedPaths || []).join(", ")}`
        : confinedButEmpty
          ? `confined but produced NO captured patch — safe, but this run produced no deliverable (sandboxed=${res.sandboxed === true})`
          : `confined (status=${res.status}, sandboxed=${res.sandboxed === true})`
    };
  } catch (e) {
    return { name: `isolation:${worker}`, ok: false, detail: e.message };
  } finally {
    rmrf(repo);
  }
}

function limitStubFor(worker) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ac-doctor-limit-")));
  const file = path.join(dir, "limit.mjs");
  fs.writeFileSync(file, "#!/usr/bin/env node\nprocess.stderr.write('429 rate limit; retry-after: 60'); process.exit(1);\n");
  fs.chmodSync(file, 0o755);
  return {
    file,
    envKey: worker === "codex" ? "AGENT_COLLAB_CODEX_COMPANION" : `AGENT_COLLAB_${worker.toUpperCase()}_BIN`
  };
}

function liveFallbackCheck(targets) {
  const writeTargets = targets.filter((w) => w !== "codex");
  if (writeTargets.length < 2) return null;
  const [first, second] = writeTargets;
  const stub = limitStubFor(first);
  const old = process.env[stub.envKey];
  const repo = seedRepo();
  try {
    process.env[stub.envKey] = stub.file;
    const res = runWithFallback(repo, {
      driver: "doctor",
      worker: first,
      role: "worker",
      brief: "Create a new file `note.txt` containing exactly the text: ok. Modify nothing else.",
      available: [first, second],
      maxAttempts: 1
    });
    const ok = res.status === "completed" && res.worker === second && res.fellBackFrom?.[0]?.worker === first;
    return {
      name: `fallback:${first}->${second}`,
      ok,
      detail: ok
        ? `fell back after ${first} (${res.fellBackFrom[0].failureKind}) and completed on ${second}`
        : `status=${res.status} worker=${res.worker} ${(res.errors || []).join("; ")}`
    };
  } catch (e) {
    return { name: `fallback:${first}->${second}`, ok: false, detail: e.message };
  } finally {
    if (old === undefined) delete process.env[stub.envKey];
    else process.env[stub.envKey] = old;
    rmrf(repo);
    rmrf(path.dirname(stub.file));
  }
}

/**
 * Run the doctor checks. Returns { ready, live, checks: [{name, ok, detail}], ok }.
 * `live` runs real worker calls (spends model usage); `workers` restricts which
 * worker-ready harnesses are exercised.
 *
 * NOTE: the isolation check runs against a throwaway repo. A worker that only
 * misbehaves when a *more canonical* checkout is discoverable may look clean here —
 * but the check still catches any escape that does occur (breach detection compares
 * the seeded repo's tree). It validates transport + containment, not absence of all
 * possible escape conditions.
 */
export function runDoctor(cwd, { live = false, workers } = {}) {
  const setup = runSetup();
  const ready = setup.filter((r) => r.validWorker).map((r) => r.name);
  const checks = [];
  checks.push({ name: "version", ok: true, detail: version() });

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node>=20", ok: major >= 20, detail: `node ${process.versions.node}` });

  const stateDir = resolveStateDir(cwd);
  let stateOk = true;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.accessSync(stateDir, fs.constants.W_OK);
  } catch {
    stateOk = false;
  }
  checks.push({ name: "state-dir-writable", ok: stateOk, detail: stateDir });

  checks.push({ name: "workers-ready", ok: ready.length > 0, detail: ready.join(", ") || "none" });

  if (live) {
    const targets = (workers && workers.length ? workers : ready).filter((w) => ready.includes(w));
    for (const w of targets) {
      checks.push(liveReviewCheck(w));
      checks.push(liveIsolationCheck(w));
    }
    const fallback = liveFallbackCheck(targets);
    if (fallback) checks.push(fallback);
  }

  return { ready, live, checks, ok: checks.every((c) => c.ok) };
}
