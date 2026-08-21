import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { makeRepo, addWorktree, isolateStateRoot, stubBin, real, git } from "./helpers.mjs";
import {
  decideRoute,
  runSetup,
  runWorkerSync,
  runWithFallback,
  resolveFallbackKinds,
  resolveSandbox,
  isSandboxStartupFailure,
  launchBackground,
  waitForJob,
  refreshJobStatus,
  defaultTimeoutMs,
  defaultIdleMs,
  applyResult
} from "../core/dispatch.mjs";
import { appendJob, updateJob, getJob, resolveStateDir } from "../core/state.mjs";
import { MODEL_PROFILES } from "../core/model-profiles.mjs";
import { headRef } from "../core/git.mjs";
import { createWorktree, resolveWorkspaceRoot } from "../core/workspace.mjs";

// ---- routing ----

test("decideRoute picks the native path when driver and worker match", () => {
  const r = decideRoute({ driver: "claude", worker: "claude" });
  assert.equal(r.mode, "native");
  assert.match(r.instruction, /Agent tool/i);
});

test("decideRoute picks the cross-harness path for different harnesses", () => {
  const r = decideRoute({ driver: "claude", worker: "agy" });
  assert.equal(r.mode, "cross");
  assert.equal(r.worker, "agy");
});

// ---- setup probe ----

test("runSetup marks available+unattended harnesses as valid workers", () => {
  const fakes = [
    { name: "ok", probe: () => ({ available: true, version: "1" }), unattendedProbe: () => ({ ok: true }) },
    { name: "blocks", probe: () => ({ available: true, version: "1" }), unattendedProbe: () => ({ ok: false, detail: "would prompt" }) },
    { name: "missing", probe: () => ({ available: false, error: "not found" }), unattendedProbe: () => ({ ok: true }) }
  ];
  const rows = runSetup(fakes);
  assert.equal(rows.find((r) => r.name === "ok").validWorker, true);
  assert.equal(rows.find((r) => r.name === "blocks").validWorker, false);
  assert.equal(rows.find((r) => r.name === "missing").validWorker, false);
});

// ---- cross-harness worker execution ----

const WRITE_STUB = `
import fs from 'node:fs';
if (process.argv.includes('models')) { process.stdout.write('Gemini 3.5 Flash (High)'); process.exit(0); }
fs.writeFileSync('worker-was-here.txt', 'hi from worker\\n');
process.stdout.write('Done.\\n\\n\`\`\`json\\n{"status":"completed","summary":"made a file","changed":true}\\n\`\`\`\\n');
`;

test("runWorkerSync blocks write-workers whose profile cannot deliver patches", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const old = MODEL_PROFILES.agy.canWrite;
  const oldAllow = process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  MODEL_PROFILES.agy.canWrite = false;
  delete process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "make a file" });

  assert.equal(res.status, "blocked");
  assert.equal(res.failureKind, "unsupported-worker");
  assert.match(res.errors.join(" "), /cannot deliver patches/i);
  assert.equal(fs.existsSync(path.join(repo, "worker-was-here.txt")), false);

  MODEL_PROFILES.agy.canWrite = old;
  if (oldAllow === undefined) delete process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  else process.env.AGENT_COLLAB_ALLOW_NONWRITER = oldAllow;
  delete process.env.AGENT_COLLAB_AGY_BIN;
});

// ---- #807: a brief must never name the controller's own live path ----

test("runWorkerSync blocks a write-worker brief that names the controller's own live worktree (#807)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  // Reproduces the documented 2026-08-13 #599 Plan 2 round-5 shape exactly: the
  // controller dispatches FROM inside its own linked worktree, and the brief
  // opens with that same worktree's path instead of letting the isolated
  // worker worktree be implicit.
  const controllerWorktree = addWorktree(repo, "plan2-week-composer");
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(controllerWorktree, {
    driver: "claude",
    worker: "agy",
    role: "worker",
    brief: `Work in ${controllerWorktree} and edit the composer.`
  });

  assert.equal(res.status, "blocked");
  assert.equal(res.failureKind, "brief-path-leak");
  assert.match(res.errors.join(" "), new RegExp(controllerWorktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Never spawned: no patch captured, no leaked file anywhere the worker could reach.
  assert.equal(fs.existsSync(path.join(controllerWorktree, "worker-was-here.txt")), false);
  assert.equal(fs.existsSync(path.join(res.artifactDir, "patches", "agy.diff")), false);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWorkerSync blocks a write-worker brief that names the main repo root, not just the exact cwd (#807)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const controllerWorktree = addWorktree(repo, "other-task");
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  // Dispatch FROM the worktree, but the brief names the shared MAIN checkout
  // root instead of the worktree itself — still the controller's own live path.
  assert.equal(resolveWorkspaceRoot(controllerWorktree), repo);
  const res = runWorkerSync(controllerWorktree, {
    driver: "claude",
    worker: "agy",
    role: "worker",
    brief: `The repo lives at ${repo} — go edit it there.`
  });

  assert.equal(res.status, "blocked");
  assert.equal(res.failureKind, "brief-path-leak");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWorkerSync does not false-positive on an ordinary brief with no live-path reference", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(repo, {
    driver: "claude",
    worker: "agy",
    role: "worker",
    brief: "Make a file. For context, this class of bug once reproduced at /tmp/some/unrelated/path/Foo.swift."
  });

  assert.equal(res.status, "completed");
  assert.notEqual(res.failureKind, "brief-path-leak");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWorkerSync does not false-positive on a path that merely shares a prefix with cwd (#807)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  // A bare substring check on `repo` (e.g. ".../ac-repo-abc123") would wrongly
  // match inside an unrelated sibling like ".../ac-repo-abc123-shared/File.md".
  const res = runWorkerSync(repo, {
    driver: "claude",
    worker: "agy",
    role: "worker",
    brief: `Make a file. See ${repo}-shared/File.md for the related change in a different project.`
  });

  assert.equal(res.status, "completed");
  assert.notEqual(res.failureKind, "brief-path-leak");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWorkerSync blocks a write-worker brief that names a SIBLING worktree, not just the one it's dispatched from (#807)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const dispatchFrom = addWorktree(repo, "current-task");
  const otherWorktree = addWorktree(repo, "someone-elses-task");
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  // Dispatched from ITS OWN worktree, but the brief names a DIFFERENT live
  // worktree of the same repo — still a live, shared checkout, and breach
  // detection (which only watches `cwd`) would never see a write landing there.
  const res = runWorkerSync(dispatchFrom, {
    driver: "claude",
    worker: "agy",
    role: "worker",
    brief: `Go work in ${otherWorktree} instead.`
  });

  assert.equal(res.status, "blocked");
  assert.equal(res.failureKind, "brief-path-leak");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWorkerSync warns but does not block a reviewer brief that names the live path (#807)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const controllerWorktree = addWorktree(repo, "review-task");
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(REVIEW_STUB);
  const originalError = console.error;
  const warnings = [];
  console.error = (msg) => warnings.push(String(msg));

  let res;
  try {
    res = runWorkerSync(controllerWorktree, {
      driver: "claude",
      worker: "agy",
      role: "reviewer",
      brief: `Review the change at ${controllerWorktree}.`
    });
  } finally {
    console.error = originalError;
  }

  assert.notEqual(res.status, "blocked");
  assert.notEqual(res.failureKind, "brief-path-leak");
  assert.ok(
    warnings.some((w) => w.includes(controllerWorktree)),
    "expected a live-path warning naming the leaked path on stderr"
  );

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWorkerSync lets codex run as a write-worker and captures its patch", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const oldAllow = process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  delete process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    import fs from 'node:fs';
    fs.writeFileSync('codex-wrote.txt', 'hi from codex\\n');
    const result = JSON.stringify({status:'completed',summary:'codex wrote a file',changed:true});
    process.stdout.write(JSON.stringify({ status: 0, rawOutput: '\`\`\`json\\n' + result + '\\n\`\`\`' }));
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "codex", role: "worker", brief: "make a file", maxAttempts: 1, noResume: true });

  assert.equal(res.status, "completed");
  assert.equal(res.valid, true);
  assert.equal(res.artifact.summary, "codex wrote a file");

  const diff = fs.readFileSync(path.join(res.artifactDir, "patches", "codex.diff"), "utf8");
  assert.match(diff, /codex-wrote\.txt/);

  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
  if (oldAllow === undefined) delete process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  else process.env.AGENT_COLLAB_ALLOW_NONWRITER = oldAllow;
});

test("runWorkerSync (worker) writes a valid result and a captured patch", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "make a file" });

  assert.equal(res.status, "completed");
  assert.equal(res.valid, true);
  assert.equal(res.artifact.summary, "made a file");

  const diff = fs.readFileSync(path.join(res.artifactDir, "patches", "agy.diff"), "utf8");
  assert.match(diff, /worker-was-here\.txt/);
  const out = JSON.parse(fs.readFileSync(path.join(res.artifactDir, "outputs", "agy.json"), "utf8"));
  assert.equal(out.status, "completed");
  // worktree should NOT have leaked into the main repo
  assert.equal(fs.existsSync(path.join(repo, "worker-was-here.txt")), false);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("applyResult applies the worker's patch to the main repo", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x" });
  const applied = applyResult(repo, res.jobId);

  assert.equal(applied.applied, true);
  assert.equal(fs.readFileSync(path.join(repo, "worker-was-here.txt"), "utf8"), "hi from worker\n");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("applyResult lands the change in the working tree UNSTAGED, leaving a clean index", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x" });
  const applied = applyResult(repo, res.jobId);

  assert.equal(applied.applied, true);
  assert.equal(applied.staged, false);
  assert.equal(fs.existsSync(path.join(repo, "worker-was-here.txt")), true);
  assert.equal(
    git(["diff", "--cached", "--name-only"], repo),
    "",
    "apply must leave a CLEAN index (change is unstaged in the working tree) so a later apply doesn't index-conflict"
  );

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("applyResult returns applied paths and a diffstat", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x" });
  const applied = applyResult(repo, res.jobId);

  assert.deepEqual(applied.paths, ["worker-was-here.txt"]);
  assert.match(applied.stat, /worker-was-here\.txt/);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

// A worker that does real work (writes a file) but replies in prose, not JSON.
const PROSE_WORKER_STUB = `
import fs from 'node:fs';
if (process.argv.includes('models')) { process.stdout.write('Gemini 3.5 Flash (High)'); process.exit(0); }
fs.writeFileSync('fix.txt', 'fixed\\n');
process.stdout.write('All done — I fixed the bug for you.');
`;

test("a worker with a valid patch is completed even without result-JSON", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(PROSE_WORKER_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "fix it" });

  assert.equal(res.status, "completed", "the patch is the deliverable");
  assert.equal(res.changed, true);
  assert.equal(res.patchApplies, true);
  assert.equal(res.resultValid, false, "no valid result-JSON, but still completed");
  const diff = fs.readFileSync(path.join(res.artifactDir, "patches", "agy.diff"), "utf8");
  assert.match(diff, /fix\.txt/);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

// A worker that neither changes anything nor returns valid JSON => failed.
const NOOP_WORKER_STUB = `process.stdout.write('I could not figure it out.');`;

test("a worker that produces nothing and no valid result is failed", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(NOOP_WORKER_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "fix it" });

  assert.equal(res.status, "failed");
  assert.equal(res.changed, false);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWorkerSync persists raw stdout/stderr and command metadata for failed sync runs", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) process.exit(0);
    process.stdout.write('plain progress\\n');
    process.stderr.write('diagnostic detail\\n');
    process.exit(1);
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review\\nsecret", maxAttempts: 1 });

  assert.equal(res.status, "failed");
  assert.equal(fs.readFileSync(path.join(res.artifactDir, "logs", "agy.stdout.log"), "utf8"), "plain progress\n");
  assert.equal(fs.readFileSync(path.join(res.artifactDir, "logs", "agy.stderr.log"), "utf8"), "diagnostic detail\n");
  const meta = JSON.parse(fs.readFileSync(path.join(res.artifactDir, "logs", "run.jsonl"), "utf8").trim());
  assert.equal(meta.worker, "agy");
  assert.equal(meta.attempt, 1);
  assert.equal(meta.exitCode, 1);
  assert.equal(meta.stdoutBytes, "plain progress\n".length);
  assert.equal(meta.stderrBytes, "diagnostic detail\n".length);
  assert.ok(meta.args.some((a) => /redacted/.test(a)), "brief-like argv must be redacted in metadata");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("review jobs fail closed when dirty natural-language input leaves the surface ambiguous", () => {
  isolateStateRoot();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "local-only.txt"), "dirty\\n");
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(REVIEW_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", kind: "review", brief: "review the current branch", maxAttempts: 1 });
  const job = getJob(repo, res.jobId);

  assert.equal(res.status, "blocked");
  assert.equal(job.failureKind, "review-surface");
  assert.match(job.errors[0], /--surface working-tree.*--surface head/i);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

const REVIEW_STUB = `
process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'approve',summary:'looks good',findings:[],next_steps:[]}) + '\\n\`\`\`');
`;

test("runWorkerSync (reviewer) validates against the review schema, no patch", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(REVIEW_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review" });
  const job = getJob(repo, res.jobId);

  assert.equal(res.valid, true);
  assert.equal(res.artifact.verdict, "approve");
  assert.match(job.runtimeVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isFinite(job.durationMs));
  assert.ok(job.completedAt);
  assert.equal(fs.existsSync(path.join(res.artifactDir, "patches", "agy.diff")), false);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("reviewer verdict synonyms and top-level extras are normalized", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'Approved',summary:'ok',findings:[],risk:'low'}) + '\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review" });

  assert.equal(res.status, "completed");
  assert.equal(res.resultValid, true);
  assert.equal(res.artifact.verdict, "approve");
  assert.equal("risk" in res.artifact, false);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("a reviewer with prose but invalid JSON completes with an unparsed report", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`process.stdout.write('Verdict: approve\\nNo findings.');`);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review", maxAttempts: 1 });

  assert.equal(res.status, "completed");
  assert.equal(res.resultValid, false);
  assert.equal(res.report, true);
  assert.match(res.note, /read the prose/i);
  assert.match(fs.readFileSync(path.join(res.artifactDir, "reports", "agy.md"), "utf8"), /No findings/);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("a reviewer cannot write to the main tree (runs isolated)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    if (process.argv.includes('models')) { process.stdout.write('Gemini 3.5 Flash (High)'); process.exit(0); }
    fs.writeFileSync('reviewer-wrote-this.txt', 'should not reach main\\n');
    process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'approve',summary:'ok',findings:[],next_steps:[]}) + '\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review" });

  assert.equal(res.valid, true, "review still validates");
  assert.equal(
    fs.existsSync(path.join(repo, "reviewer-wrote-this.txt")),
    false,
    "a reviewer's stray write must not reach the main tree"
  );

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("the worker prompt includes the required output schema on the first attempt", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const promptFile = path.join(isolateStateRoot(), "prompt.txt");
  process.env.AC_PROMPT_FILE = promptFile;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    fs.writeFileSync(process.env.AC_PROMPT_FILE, process.argv[process.argv.length - 1]);
    process.stdout.write('\`\`\`json\\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\\n\`\`\`');
  `);

  runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review X" });
  const sent = fs.readFileSync(promptFile, "utf8");
  assert.match(sent, /review X/);
  assert.match(sent, /verdict/, "schema contract injected into the prompt");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_PROMPT_FILE;
});

test("a review (kind) uses the template + the harness output contract", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const promptFile = path.join(isolateStateRoot(), "p.txt");
  process.env.AC_PROMPT_FILE = promptFile;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    if (process.argv.includes('models')) { process.exit(0); }
    fs.writeFileSync(process.env.AC_PROMPT_FILE, process.argv[process.argv.length - 1]);
    process.stdout.write('\`\`\`json\\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, {
    driver: "claude",
    worker: "agy",
    role: "reviewer",
    kind: "adversarial-review",
    brief: "DIFF_TO_REVIEW_XYZ"
  });

  const sent = fs.readFileSync(promptFile, "utf8");
  assert.match(sent, /<attack_surface>/, "uses the adversarial-review template");
  assert.match(sent, /DIFF_TO_REVIEW_XYZ/, "review input injected");
  assert.match(sent, /ONLY a JSON/i, "agy output contract injected into {{OUTPUT_CONTRACT}}");
  assert.match(getJob(repo, res.jobId).templateDigest, /^[a-f0-9]{64}$/);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_PROMPT_FILE;
});

// ---- failure classification + auto-fallback ----

// A worker that hits a subscription/rate limit: prints a limit error, exits non-zero,
// changes nothing.
const RATE_LIMITED_STUB = `
  if (process.argv.includes('models')) { process.exit(0); }
  process.stderr.write('Error: 429 RESOURCE_EXHAUSTED quota exceeded; retry-after: 60\\n');
  process.exit(1);
`;

test("runWorkerSync tags a rate-limited failure with failureKind + worker", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(RATE_LIMITED_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "rate-limit");
  assert.equal(res.worker, "agy");
  assert.match(res.resetAt, /60/);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("an ordinary failure is tagged failureKind=other, not a limit", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(NOOP_WORKER_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "other");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

// A worker that succeeds: writes a file and returns a JSON result (claude envelope).
const CLAUDE_SUCCESS_STUB = `
  import fs from 'node:fs';
  fs.writeFileSync('done.txt', 'ok\\n');
  process.stdout.write(JSON.stringify({ result: 'Done.\\n\\n\`\`\`json\\n{"status":"completed","summary":"did it","changed":true}\\n\`\`\`' }));
`;

test("runWithFallback falls back to another worker when the first is rate-limited", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(RATE_LIMITED_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex",
    worker: "agy",
    role: "worker",
    brief: "x",
    available: ["agy", "claude"],
    maxAttempts: 1
  });

  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude", "fell back to claude");
  assert.ok(Array.isArray(res.fellBackFrom));
  assert.equal(res.fellBackFrom[0].worker, "agy");
  assert.equal(res.fellBackFrom[0].failureKind, "rate-limit");
  assert.match(res.note, /agy/);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("runWithFallback falls back when a worker exits 0 with empty output", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`if (process.argv.includes('models')) process.exit(0); process.exit(0);`);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex",
    worker: "agy",
    role: "worker",
    brief: "x",
    available: ["agy", "claude"],
    maxAttempts: 1
  });

  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude");
  assert.equal(res.fellBackFrom[0].failureKind, "empty-output");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

// opencode x-preview-f null-turn: exit 0, full NDJSON stdout, terminal step with
 // no text. Must be failed/empty-output (fallback-eligible), never completed or other.
const OPENCODE_NULL_TURN_STUB = `
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
const lines = [
  '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","type":"step-start"}}',
  '{"type":"tool_use","timestamp":2,"sessionID":"s1","part":{"type":"tool","tool":"read"}}',
  '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"id":"p3","reason":"tool-calls","tokens":{"total":100,"input":50,"output":10,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
  '{"type":"step_start","timestamp":4,"sessionID":"s1","part":{"id":"p4","type":"step-start"}}',
  '{"type":"step_finish","timestamp":5,"sessionID":"s1","part":{"id":"p5","reason":"unknown","tokens":{"input":0,"output":0,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}'
];
process.stdout.write(lines.join('\\n') + '\\n');
process.exit(0);
`;

// First invocation: null turn with a session id. Session-continue nudge: write a
// file and emit a valid worker JSON result.
const OPENCODE_NULL_THEN_CONTINUE_STUB = `
import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
if (process.argv.includes('--session')) {
  fs.writeFileSync('done.txt', 'nudged\\n');
  const text = JSON.stringify({ status: 'completed', summary: 'continued after null turn', changed: true });
  process.stdout.write([
    '{"type":"step_start","timestamp":1,"sessionID":"ses_live","part":{"id":"p1","type":"step-start"}}',
    JSON.stringify({ type: 'text', timestamp: 2, sessionID: 'ses_live', part: { id: 'p2', type: 'text', text: text } }),
    '{"type":"step_finish","timestamp":3,"sessionID":"ses_live","part":{"id":"p3","reason":"stop","tokens":{"input":10,"output":5,"total":15},"cost":0}}'
  ].join('\\n') + '\\n');
  process.exit(0);
}
process.stdout.write([
  '{"type":"step_start","timestamp":1,"sessionID":"ses_live","part":{"id":"p1","type":"step-start"}}',
  '{"type":"tool_use","timestamp":2,"sessionID":"ses_live","part":{"type":"tool","tool":"read"}}',
  '{"type":"step_finish","timestamp":3,"sessionID":"ses_live","part":{"id":"p3","reason":"tool-calls","tokens":{"total":100,"input":50,"output":10,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}',
  '{"type":"step_start","timestamp":4,"sessionID":"ses_live","part":{"id":"p4","type":"step-start"}}',
  '{"type":"step_finish","timestamp":5,"sessionID":"ses_live","part":{"id":"p5","reason":"unknown","tokens":{"input":0,"output":0,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}}'
].join('\\n') + '\\n');
process.exit(0);
`;

test("opencode null-turn worker is failed with failureKind=empty-output", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_OPENCODE_BIN = stubBin(OPENCODE_NULL_TURN_STUB);

  const res = runWorkerSync(repo, {
    driver: "claude",
    worker: "opencode",
    role: "worker",
    brief: "x",
    maxAttempts: 2
  });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "empty-output");
  assert.equal(res.attempts, 2, "null-turn should attempt one same-session continue before failing");
  assert.match(res.errors.join(" "), /null turn/i);
  assert.equal(res.workerTelemetry?.nullTurn, true);
  const report = fs.readFileSync(path.join(res.artifactDir, "reports", "opencode.md"), "utf8");
  assert.match(report, /⚠️ INCOMPLETE RUN/);
  assert.doesNotMatch(report, /"type":"step_start"/);

  delete process.env.AGENT_COLLAB_OPENCODE_BIN;
});

test("opencode null-turn continues the same session and can recover", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_OPENCODE_BIN = stubBin(OPENCODE_NULL_THEN_CONTINUE_STUB);

  const res = runWorkerSync(repo, {
    driver: "claude",
    worker: "opencode",
    role: "worker",
    brief: "x",
    maxAttempts: 2
  });

  assert.equal(res.status, "completed", JSON.stringify({ status: res.status, errors: res.errors, attempts: res.attempts }));
  assert.equal(res.attempts, 2);
  assert.equal(res.changed, true);
  const diff = fs.readFileSync(path.join(res.artifactDir, "patches", "opencode.diff"), "utf8");
  assert.match(diff, /done\.txt/);

  delete process.env.AGENT_COLLAB_OPENCODE_BIN;
});

test("opencode null-turn reviewer is failed with empty-output, not completed-with-prose", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_OPENCODE_BIN = stubBin(OPENCODE_NULL_TURN_STUB);

  const res = runWorkerSync(repo, {
    driver: "claude",
    worker: "opencode",
    role: "reviewer",
    brief: "review",
    maxAttempts: 2
  });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "empty-output");
  assert.match(res.errors.join(" "), /null turn/i);

  delete process.env.AGENT_COLLAB_OPENCODE_BIN;
});

test("opencode null-turn is empty-output; explicitOnly still blocks cascade to other harnesses", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_OPENCODE_BIN = stubBin(OPENCODE_NULL_TURN_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex",
    worker: "opencode",
    role: "worker",
    brief: "x",
    available: ["opencode", "claude"],
    maxAttempts: 1
  });

  assert.equal(res.status, "failed");
  assert.equal(res.worker, "opencode");
  assert.equal(res.failureKind, "empty-output");
  assert.equal(resolveFallbackKinds().has("empty-output"), true);
  assert.equal(res.allWorkersLimited, true);
  assert.equal(res.fellBackFrom.length, 1, "only opencode was tried — claude not appended (explicitOnly)");
  assert.equal(res.fellBackFrom[0].failureKind, "empty-output");

  delete process.env.AGENT_COLLAB_OPENCODE_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("runWithFallback skips non-writer fallback candidates for write roles", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const old = MODEL_PROFILES.agy.canWrite;
  const oldAllow = process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  MODEL_PROFILES.agy.canWrite = false;
  delete process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(RATE_LIMITED_STUB);

  const res = runWithFallback(repo, {
    driver: "manual",
    worker: "claude",
    role: "worker",
    brief: "x",
    available: ["claude", "agy"],
    maxAttempts: 1
  });

  assert.equal(res.status, "failed");
  assert.equal(res.allWorkersLimited, true);
  assert.deepEqual(res.fellBackFrom.map((f) => f.worker), ["claude"]);

  MODEL_PROFILES.agy.canWrite = old;
  if (oldAllow === undefined) delete process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  else process.env.AGENT_COLLAB_ALLOW_NONWRITER = oldAllow;
  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("runWithFallback always tries the explicit worker, even if it equals the driver label", () => {
  // The driver is only a guessed "claude" label, but the user explicitly asked
  // for the claude worker — it must still run (not get excluded as the driver).
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "claude",
    worker: "claude",
    role: "worker",
    brief: "x",
    available: ["claude", "agy"],
    maxAttempts: 1
  });

  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude");

  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("runWithFallback never falls away from an explicitOnly worker on failure", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const originalProfile = MODEL_PROFILES.agy;
  MODEL_PROFILES.agy = { ...originalProfile, explicitOnly: true };
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(RATE_LIMITED_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex",
    worker: "agy",
    role: "worker",
    brief: "x",
    available: ["agy", "claude"],
    maxAttempts: 1
  });

  assert.equal(res.status, "failed", "must surface the failure, not fall through to claude");
  assert.equal(res.allWorkersLimited, true);
  assert.equal(res.fellBackFrom.length, 1, "only agy was ever tried — claude was never appended as a candidate");
  assert.equal(res.fellBackFrom[0].worker, "agy");

  MODEL_PROFILES.agy = originalProfile;
  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("runWithFallback never auto-appends an explicitOnly harness as a fallback for a DIFFERENT worker", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const originalProfile = MODEL_PROFILES.agy;
  MODEL_PROFILES.agy = { ...originalProfile, explicitOnly: true };
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    process.stdout.write(JSON.stringify({
      status: 1,
      rawOutput: JSON.stringify({status:"failed",summary:"429 RESOURCE_EXHAUSTED quota exceeded",changed:false})
    }));
  `);
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWithFallback(repo, {
    driver: "manual",
    worker: "codex",
    role: "worker",
    brief: "x",
    available: ["codex", "agy"],
    maxAttempts: 1
  });

  assert.equal(res.status, "failed", "must surface — agy is explicitOnly, never auto-tried");
  assert.equal(res.allWorkersLimited, true);
  assert.equal(res.fellBackFrom.length, 1, "only codex was ever tried — agy was never appended as a candidate");
  assert.equal(res.fellBackFrom[0].worker, "codex");

  MODEL_PROFILES.agy = originalProfile;
  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("a cleanEnv harness does not inherit ambient environment variables", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_TEST_SECRET = "leaked-if-inherited";
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(`
    process.stdout.write(JSON.stringify({
      result: JSON.stringify({
        status: "completed",
        summary: process.env.AGENT_COLLAB_TEST_SECRET ? "SECRET_PRESENT" : "SECRET_ABSENT",
        changed: false
      })
    }));
  `);

  const original = MODEL_PROFILES.claude.cleanEnv;
  MODEL_PROFILES.claude.cleanEnv = true; // simulate a cleanEnv harness without needing qwen yet (Task 6)

  const res = runWorkerSync(repo, { driver: "codex", worker: "claude", role: "worker", brief: "x" });

  assert.equal(res.artifact.summary, "SECRET_ABSENT", "ambient env must not reach a cleanEnv harness's process");

  MODEL_PROFILES.claude.cleanEnv = original;
  delete process.env.AGENT_COLLAB_TEST_SECRET;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

// A reviewer that returns a complete report but with capitalized severity +
// no next_steps (exactly what codex did) must be normalized & completed, not
// false-failed.
const HIGH_SEV_REVIEW_STUB = `
  if (process.argv.includes('models')) { process.exit(0); }
  process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'Approve',summary:'ok',findings:[{severity:'High',title:'t',body:'b'}]}) + '\\n\`\`\`');
`;

test("a reviewer with capitalized severity is normalized and completed (not false-failed)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(HIGH_SEV_REVIEW_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review" });

  assert.equal(res.status, "completed");
  assert.equal(res.valid, true);
  assert.equal(res.artifact.verdict, "approve");
  assert.equal(res.artifact.findings[0].severity, "high");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

// A worker that runs longer than the timeout: spawnSync SIGTERMs it before it can
// print, so stdout is empty — the dominant codex no-output failure.
const SLOW_STUB = `
  if (process.argv.includes('models')) { process.exit(0); }
  await new Promise((r) => setTimeout(r, 5000));
  process.stdout.write('too late');
`;

test("a worker killed by timeout is classified failureKind=timeout and does not retry", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const countFile = path.join(isolateStateRoot(), "count.txt");
  process.env.AC_COUNT_FILE = countFile;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    if (process.argv.includes('models')) { process.exit(0); }
    const f = process.env.AC_COUNT_FILE;
    fs.writeFileSync(f, String((fs.existsSync(f) ? Number(fs.readFileSync(f,'utf8')) : 0) + 1));
    await new Promise((r) => setTimeout(r, 5000));
    process.stdout.write('too late');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", timeoutMs: 600, maxAttempts: 2 });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "timeout");
  assert.match(res.errors.join(" "), /timeout|AGENT_COLLAB_TIMEOUT/i);
  assert.equal(Number(fs.readFileSync(countFile, "utf8")), 1, "must not re-send the same slow prompt");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_COUNT_FILE;
});

test("runWithFallback falls back when the first worker times out", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(SLOW_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex",
    worker: "agy",
    role: "worker",
    brief: "x",
    available: ["agy", "claude"],
    timeoutMs: 600,
    maxAttempts: 1
  });

  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude");
  assert.equal(res.fellBackFrom[0].failureKind, "timeout");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("defaultTimeoutMs honors AGENT_COLLAB_TIMEOUT and defaults generously", () => {
  delete process.env.AGENT_COLLAB_TIMEOUT;
  assert.ok(defaultTimeoutMs() >= 900000, "default is generous (>= 15 min) so deep reviews aren't killed");
  process.env.AGENT_COLLAB_TIMEOUT = "60";
  assert.equal(defaultTimeoutMs(), 60000);
  delete process.env.AGENT_COLLAB_TIMEOUT;
});

// ---- review input: stage the diff into the worktree (post-change, not stale HEAD) ----

// A reviewer stub that records what it sees on disk + whether the prompt says "staged".
const STAGE_PROBE_STUB = `
  import fs from 'node:fs';
  if (process.argv.includes('models')) { process.exit(0); }
  const prompt = process.argv[process.argv.length - 1];
  const app = fs.existsSync('app.js') ? fs.readFileSync('app.js', 'utf8') : '';
  const local = fs.existsSync('local-only.txt') ? fs.readFileSync('local-only.txt', 'utf8') : '';
  fs.writeFileSync(process.env.AC_SEEN, JSON.stringify({
    appOnDisk: app.trim(),
    localOnDisk: local.trim(),
    promptSaysApplied: /has been APPLIED to your working tree/.test(prompt),
    promptSaysBaseline: /committed HEAD surface/i.test(prompt)
  }));
  process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'approve',summary:'ok',findings:[]}) + '\\n\`\`\`');
`;

test("a review STAGES a real diff into the worktree (reviewer sees post-change files)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "app.js"), "const x = 1;\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "add app"], repo);
  // produce a real unified diff (x=1 -> x=2), then revert so HEAD baseline is x=1
  fs.writeFileSync(path.join(repo, "app.js"), "const x = 2;\n");
  const diff = git(["diff"], repo);
  git(["checkout", "--", "app.js"], repo);

  const seen = path.join(real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-seen-"))), "seen.json");
  process.env.AC_SEEN = seen;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(STAGE_PROBE_STUB);

  runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", kind: "review", brief: diff });

  const got = JSON.parse(fs.readFileSync(seen, "utf8"));
  assert.equal(got.appOnDisk, "const x = 2;", "the worktree shows the POST-change file, not stale HEAD");
  assert.equal(got.promptSaysApplied, true, "the prompt tells the reviewer the change is applied");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_SEEN;
});

test("a clean review with non-diff input defaults explicitly to HEAD", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const seen = path.join(real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-seen-"))), "seen.json");
  process.env.AC_SEEN = seen;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(STAGE_PROBE_STUB);

  runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", kind: "review", brief: "Please review the auth flow for race conditions." });

  const got = JSON.parse(fs.readFileSync(seen, "utf8"));
  assert.equal(got.promptSaysApplied, false);
  assert.equal(got.promptSaysBaseline, true, "non-diff input keeps the HEAD-baseline framing");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_SEEN;
});

test("working-tree surface snapshots dirty content without changing the real index", () => {
  isolateStateRoot();
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "app.js"), "const x = 1;\n");
  git(["add", "app.js"], repo);
  git(["commit", "-q", "-m", "add app"], repo);
  fs.writeFileSync(path.join(repo, "app.js"), "const x = 2;\n");
  git(["add", "app.js"], repo);
  fs.writeFileSync(path.join(repo, "local-only.txt"), "included\n");
  const stagedBefore = git(["diff", "--cached", "--name-only"], repo);

  const seen = path.join(real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-seen-"))), "seen.json");
  process.env.AC_SEEN = seen;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(STAGE_PROBE_STUB);

  const res = runWorkerSync(repo, {
    driver: "claude", worker: "agy", role: "reviewer", kind: "review",
    surface: "working-tree", brief: "Review the current checkout."
  });
  const got = JSON.parse(fs.readFileSync(seen, "utf8"));
  const job = getJob(repo, res.jobId);

  assert.equal(got.appOnDisk, "const x = 2;");
  assert.equal(got.localOnDisk, "included");
  assert.equal(git(["diff", "--cached", "--name-only"], repo), stagedBefore);
  assert.equal(job.reviewContext.surface, "working-tree");
  assert.equal(job.reviewContext.stagedIntoWorktree, true);
  assert.ok(job.reviewContext.sourceSnapshotDigest);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_SEEN;
});

// ---- async background execution ----

test("launchBackground runs a worker detached; waitForJob blocks until completed", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const launched = launchBackground(repo, { driver: "claude", worker: "agy", role: "worker", brief: "make a file", maxAttempts: 1 });
  assert.equal(launched.status, "running");
  assert.ok(launched.jobId);

  const job = waitForJob(repo, launched.jobId, { timeoutMs: 30000, pollMs: 150 });
  assert.equal(job.status, "completed", JSON.stringify(job));

  const diff = fs.readFileSync(path.join(launched.artifactDir, "patches", "agy.diff"), "utf8");
  assert.match(diff, /worker-was-here\.txt/);
  // background still isolates — the real repo stays clean
  assert.equal(fs.existsSync(path.join(repo, "worker-was-here.txt")), false);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("updateJob is terminal-safe: a later update can't regress/overwrite a terminal status", () => {
  isolateStateRoot();
  const repo = makeRepo();
  appendJob(repo, { id: "t1", worker: "codex", role: "worker", status: "completed" });

  // a racing background launcher trying to set running back
  updateJob(repo, "t1", { status: "running", pid: 999 });
  assert.equal(getJob(repo, "t1").status, "completed", "must not regress completed -> running");
  assert.equal(getJob(repo, "t1").pid, 999, "non-status fields still update");

  // a late cancel must not overwrite the completed result either
  updateJob(repo, "t1", { status: "cancelled" });
  assert.equal(getJob(repo, "t1").status, "completed", "terminal is final");
});

test("AGENT_COLLAB_ALLOW_INPLACE does NOT downgrade a real git repo to an in-place run", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_ALLOW_INPLACE = "on";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.notEqual(res.status, "blocked");
  // still isolated: the worker's write stayed in the worktree, not the real repo
  assert.equal(fs.existsSync(path.join(repo, "worker-was-here.txt")), false);

  delete process.env.AGENT_COLLAB_ALLOW_INPLACE;
  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("noResume disables codex --resume-last on the repair attempt (fresh re-send instead)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const marker = path.join(isolateStateRoot(), "rl.marker");
  const countFile = path.join(isolateStateRoot(), "n.txt");
  process.env.AC_MARKER = marker;
  process.env.AC_COUNT_FILE = countFile;
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    import fs from 'node:fs';
    if (process.argv.includes('--resume-last')) fs.writeFileSync(process.env.AC_MARKER, 'x');
    const f = process.env.AC_COUNT_FILE;
    const n = (fs.existsSync(f) ? Number(fs.readFileSync(f,'utf8')) : 0) + 1;
    fs.writeFileSync(f, String(n));
    if (n === 1) { process.stdout.write('prose'); }
    else { const review = JSON.stringify({verdict:'approve',summary:'ok',findings:[]}); process.stdout.write(JSON.stringify({status:0, rawOutput:'\`\`\`json\\n'+review+'\\n\`\`\`'})); }
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "codex", role: "reviewer", brief: "review", maxAttempts: 2, noResume: true });

  assert.equal(res.status, "completed");
  assert.equal(fs.existsSync(marker), false, "noResume -> never used --resume-last");

  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
  delete process.env.AC_MARKER;
  delete process.env.AC_COUNT_FILE;
});

test("waitForJob marks a job stalled when its process is gone without finishing", () => {
  isolateStateRoot();
  const repo = makeRepo();
  appendJob(repo, {
    id: "stall-1",
    worker: "agy",
    role: "worker",
    status: "running",
    pid: 2147483600, // a pid that is (almost certainly) not alive
    artifactDir: "/tmp",
    heartbeatAt: new Date().toISOString()
  });

  const job = waitForJob(repo, "stall-1", { timeoutMs: 2000, pollMs: 50 });

  assert.equal(job.status, "failed");
  assert.equal(job.failureKind, "stalled");
});

test("refreshJobStatus marks a dead running job stalled without waiting", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const workspace = createWorktree(repo, "stale-read", headRef(repo));
  appendJob(repo, {
    id: "stale-read",
    worker: "agy",
    status: "running",
    pid: 2147483646,
    workspace,
    heartbeatAt: new Date().toISOString()
  });

  const job = refreshJobStatus(repo, "stale-read");

  assert.equal(job.status, "failed");
  assert.equal(job.failureKind, "stalled");
  assert.equal(job.worktreeCleanup.removed, true);
  assert.equal(fs.existsSync(workspace), false);
});

test("refreshJobStatus does not attach stalled metadata to an already-completed job", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const stale = appendJob(repo, {
    id: "stale-complete",
    worker: "agy",
    status: "running",
    pid: 2147483645,
    heartbeatAt: new Date().toISOString()
  });
  updateJob(repo, "stale-complete", { status: "completed", exitCode: 0 });

  const job = refreshJobStatus(repo, stale);

  assert.equal(job.status, "completed");
  assert.equal(job.failureKind, undefined);
  assert.equal(job.errors, undefined);
});

// ---- inactivity (freeze) watchdog ----

test("defaultIdleMs honors AGENT_COLLAB_IDLE_TIMEOUT (incl. 0=off) and defaults generously", () => {
  delete process.env.AGENT_COLLAB_IDLE_TIMEOUT;
  assert.equal(defaultIdleMs(), 600000); // 10 min — must not false-kill a slow worker
  process.env.AGENT_COLLAB_IDLE_TIMEOUT = "60";
  assert.equal(defaultIdleMs(), 60000);
  process.env.AGENT_COLLAB_IDLE_TIMEOUT = "0";
  assert.equal(defaultIdleMs(), 0);
  delete process.env.AGENT_COLLAB_IDLE_TIMEOUT;
});

test("a worker SILENT on stdout but writing files in its worktree is NOT killed as frozen", () => {
  isolateStateRoot();
  const repo = makeRepo();
  // No stdout for ~2s, but file activity every 200ms in the worktree (cwd) — this
  // is the real-world case (claude/agy work quietly + write files) that the
  // stdout-only watchdog used to false-kill.
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    if (process.argv.includes('models')) { process.exit(0); }
    let n = 0;
    const iv = setInterval(() => { try { fs.writeFileSync('progress-' + (n++) + '.txt', 'x'); } catch {} }, 200);
    await new Promise((r) => setTimeout(r, 2000));
    clearInterval(iv);
    fs.writeFileSync('done.txt', 'ok\\n');
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"did it","changed":true}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", idleMs: 800, timeoutMs: 60000, maxAttempts: 1 });

  assert.notEqual(res.failureKind, "frozen", "file activity must count as progress");
  assert.equal(res.status, "completed");

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("a worker that goes silent past the idle window is killed FAST as 'frozen'", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    await new Promise((r) => setTimeout(r, 4000)); // produce NO output for 4s
    process.stdout.write('too late');
  `);

  const t0 = Date.now();
  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", idleMs: 800, timeoutMs: 60000, maxAttempts: 2 });
  const elapsed = Date.now() - t0;

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "frozen");
  assert.match(res.errors.join(" "), /frozen|no output/i);
  assert.ok(elapsed < 12000, `killed via idle (~1s), not the 60s hard timeout (took ${elapsed}ms)`);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("a worker that keeps producing output is NOT tripped by the idle watchdog", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    process.stdout.write('working...\\n');
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"ok","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", idleMs: 800, timeoutMs: 60000, maxAttempts: 1 });

  assert.notEqual(res.failureKind, "frozen");
  assert.equal(res.status, "no-changes"); // valid JSON, no patch — not frozen

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWithFallback falls back when the first worker FREEZES", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`if (process.argv.includes('models')) process.exit(0); await new Promise(r=>setTimeout(r,4000)); process.stdout.write('late');`);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex", worker: "agy", role: "worker", brief: "x",
    available: ["agy", "claude"], idleMs: 800, timeoutMs: 60000, maxAttempts: 1
  });

  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude");
  assert.equal(res.fellBackFrom[0].failureKind, "frozen");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("job-scoped codex companion activity counts as progress for the idle watchdog", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    import fs from 'node:fs';
    import path from 'node:path';
    const dir = path.join(process.env.CLAUDE_PLUGIN_DATA, 'state', 'job', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    let n = 0;
    const iv = setInterval(() => fs.writeFileSync(path.join(dir, 'progress-' + (n++) + '.jsonl'), 'x'), 200);
    await new Promise((r) => setTimeout(r, 1800));
    clearInterval(iv);
    const review = JSON.stringify({verdict:'approve',summary:'ok',findings:[]});
    process.stdout.write(JSON.stringify({ status: 0, rawOutput: review }));
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "codex", role: "reviewer", brief: "review", idleMs: 800, timeoutMs: 60000, maxAttempts: 1 });

  assert.equal(res.status, "completed");
  assert.notEqual(res.failureKind, "frozen");
  assert.equal(res.runtimeCleanup.attempted, true, "terminal success must run scoped cleanup");
  assert.equal(res.runtimeCleanup.ok, true);

  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
});

test("unrelated global codex activity does NOT keep a silent worker alive", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const oldHome = process.env.HOME;
  const fakeHome = real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-codex-home-")));
  const sessions = path.join(fakeHome, ".codex", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  process.env.HOME = fakeHome;
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    const dir = path.join(os.homedir(), '.codex', 'sessions');
    let n = 0;
    const iv = setInterval(() => fs.writeFileSync(path.join(dir, 'unrelated-' + (n++) + '.jsonl'), 'x'), 200);
    await new Promise((r) => setTimeout(r, 4000));
    clearInterval(iv);
    const review = JSON.stringify({verdict:'approve',summary:'late',findings:[]});
    process.stdout.write(JSON.stringify({ status: 0, rawOutput: review }));
  `);

  const res = runWorkerSync(repo, {
    driver: "claude",
    worker: "codex",
    role: "reviewer",
    brief: "review",
    idleMs: 800,
    timeoutMs: 60000,
    maxAttempts: 1
  });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "frozen");
  assert.equal(res.runtimeCleanup.attempted, true, "terminal failure must also run scoped cleanup");
  assert.equal(res.runtimeCleanup.ok, true);

  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
});

test("nested file activity counts as progress when fs.watch is unavailable", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const oldNodeOptions = process.env.NODE_OPTIONS;
  const preloadDir = real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-no-recursive-watch-")));
  const preload = path.join(preloadDir, "preload.mjs");
  fs.writeFileSync(
    preload,
    `
      import fs from 'node:fs';
      if (process.argv[1]?.endsWith('idle-guard.mjs')) {
        const statSync = fs.statSync;
        fs.watch = function patchedWatch() { throw new Error('watch unsupported'); };
        fs.statSync = function patchedStatSync(p, ...args) {
          const s = statSync.call(this, p, ...args);
          if (String(p) === process.cwd()) return { ...s, mtimeMs: 1 };
          return s;
        };
      }
    `
  );
  process.env.NODE_OPTIONS = [oldNodeOptions, `--import=${preload}`].filter(Boolean).join(" ");
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(`
    import fs from 'node:fs';
    if (process.argv.includes('models')) { process.exit(0); }
    fs.mkdirSync('nested', { recursive: true });
    fs.writeFileSync('nested/progress.txt', '0');
    let n = 1;
    const iv = setInterval(() => fs.writeFileSync('nested/progress.txt', String(n++)), 200);
    await new Promise((r) => setTimeout(r, 4000));
    clearInterval(iv);
    fs.writeFileSync('done.txt', 'ok\\n');
    const result = JSON.stringify({status:"completed",summary:"ok",changed:true});
    process.stdout.write(JSON.stringify({type:"result",result}) + "\\n");
  `);

  const res = runWorkerSync(repo, { driver: "codex", worker: "claude", role: "worker", brief: "x", idleMs: 1500, timeoutMs: 60000, maxAttempts: 1 });

  assert.equal(res.status, "completed", JSON.stringify({ status: res.status, failureKind: res.failureKind, errors: res.errors, note: res.note }));
  assert.notEqual(res.failureKind, "frozen");

  if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = oldNodeOptions;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

// ---- preventive OS-sandbox policy ----

test("resolveSandbox: opt-in for agy write-workers, never codex", () => {
  // codex self-sandboxes → never wrap it (nesting crashes)
  assert.equal(resolveSandbox({ worker: "codex", role: "worker", env: {} }).sandbox, false);
  assert.equal(resolveSandbox({ worker: "codex", role: "worker", env: { AGENT_COLLAB_SANDBOX: "on" } }).sandbox, false);

  // agy write-worker → opt-in; it must read git worktree pointers outside cwd.
  assert.equal(resolveSandbox({ worker: "agy", role: "worker", env: {} }).sandbox, false);
  // agy reviewer → opt-in (don't risk the working review path)
  assert.equal(resolveSandbox({ worker: "agy", role: "reviewer", env: {} }).sandbox, false);
  // claude worker → opt-in
  assert.equal(resolveSandbox({ worker: "claude", role: "worker", env: {} }).sandbox, false);

  // explicit toggles win
  assert.equal(resolveSandbox({ worker: "agy", role: "worker", env: { AGENT_COLLAB_SANDBOX: "off" } }).sandbox, false);
  assert.equal(resolveSandbox({ worker: "claude", role: "worker", env: { AGENT_COLLAB_SANDBOX: "on" } }).sandbox, true);
  assert.equal(resolveSandbox({ worker: "agy", role: "reviewer", config: { sandbox: true }, env: {} }).sandbox, true);
});

test("isSandboxStartupFailure detects a WRAPPER failure but not a denial/timeout/task error", () => {
  assert.equal(isSandboxStartupFailure({ status: 1, stderr: "sandbox-exec: sandbox_apply: Operation not permitted" }), true);
  assert.equal(isSandboxStartupFailure({ status: 1, stderr: "bwrap: No permissions to create new namespace" }), true);
  // CRITICAL (codex #1): a CORRECTLY sandbox-denied write prints bare EPERM
  // "operation not permitted" — this must NOT be read as a wrapper failure, else
  // we'd re-run unsandboxed and let the denied write through.
  assert.equal(isSandboxStartupFailure({ status: 1, stderr: "Error: EPERM: operation not permitted, open '/Users/x/.ssh/pwn'" }), false);
  // a timeout (error message mentions the sandbox-exec COMMAND) must NOT count
  assert.equal(isSandboxStartupFailure({ status: -1, error: { code: "ETIMEDOUT", message: "spawnSync /usr/bin/sandbox-exec ETIMEDOUT" } }), false);
  assert.equal(isSandboxStartupFailure({ status: 1, stderr: "TypeError: undefined" }), false);
  assert.equal(isSandboxStartupFailure({ status: 0 }), false);
});

// ---- isolation fail-closed (no implicit unisolated in-place runs) ----

test("runWorkerSync fails CLOSED when it cannot isolate (non-git cwd)", () => {
  isolateStateRoot();
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-nongit-")));
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(dir, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "blocked");
  assert.match(res.errors.join(" "), /isolat|git repo/i);
  assert.equal(
    fs.existsSync(path.join(dir, "worker-was-here.txt")),
    false,
    "the worker must NOT run unisolated in the real cwd"
  );

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("AGENT_COLLAB_ALLOW_INPLACE=on permits an explicit unisolated in-place run", () => {
  isolateStateRoot();
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), "ac-nongit-")));
  process.env.AGENT_COLLAB_ALLOW_INPLACE = "on";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(dir, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.notEqual(res.status, "blocked");
  assert.equal(fs.existsSync(path.join(dir, "worker-was-here.txt")), true, "ran in place as opted-in");

  delete process.env.AGENT_COLLAB_ALLOW_INPLACE;
  delete process.env.AGENT_COLLAB_AGY_BIN;
});

// ---- worker containment (breach detection) ----

test("a worker that writes OUTSIDE its worktree (into the real repo) is flagged as a breach", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    import path from 'node:path';
    if (process.argv.includes('models')) { process.exit(0); }
    fs.writeFileSync(path.join(process.env.AC_ESCAPE, 'leaked.txt'), 'escaped\\n');
    process.stdout.write('Done.\\n\\n\`\`\`json\\n{"status":"completed","summary":"x","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach", "a write into the real checkout overrides any 'completed'");
  assert.equal(res.breach, true);
  assert.ok(res.escapedPaths.some((p) => /leaked\.txt/.test(p)));
  assert.match(res.errors.join(" "), /outside its worktree|breach/i);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_ESCAPE;
});

test("a disjoint real-checkout write is still a breach even when the patch is clean", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    import path from 'node:path';
    if (process.argv.includes('models')) { process.exit(0); }
    fs.writeFileSync(path.join(process.env.AC_ESCAPE, 'leaked.txt'), 'escaped\\n');
    fs.writeFileSync('worker.txt', 'patch\\n');
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"ok","changed":true}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach");
  assert.equal(res.breach, true);
  assert.ok(res.escapedPaths.some((p) => /leaked\.txt/.test(p)));
  // #1098: keep hard breach, but never lead with "inspect and revert them" when the
  // flagged paths are disjoint from the job's captured patch (concurrent writers).
  const err = res.errors.join(" ");
  assert.match(err, /do not auto-revert|attribute each path/i);
  assert.equal(/inspect and revert them/i.test(err), false);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_ESCAPE;
});

test("an opted-in concurrent reviewer edit is a breachWarning, not a failed review breach", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const target = path.join(repo, "driver-note.txt");
  process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT = "on";
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(()=>require('node:fs').writeFileSync(process.env.TARGET, 'driver\\n'), 250)"],
    { env: { ...process.env, TARGET: target }, stdio: "ignore" }
  );
  child.unref();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    await new Promise((r) => setTimeout(r, 1200));
    process.stdout.write('\`\`\`json\\n{"verdict":"approve","summary":"ok","findings":[]}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "codex", worker: "agy", role: "reviewer", brief: "x", maxAttempts: 1 });

  assert.equal(fs.existsSync(target), true);
  assert.equal(res.status, "completed");
  assert.equal(res.breach, false);
  assert.deepEqual(res.breachWarning.escapedPaths, ["driver-note.txt"]);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT;
});

test("breach exempt paths are reported as warnings and do not override status", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_BREACH_EXEMPT_PATHS = "reports/";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    import path from 'node:path';
    if (process.argv.includes('models')) { process.exit(0); }
    fs.mkdirSync(path.join(process.env.AC_ESCAPE, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(process.env.AC_ESCAPE, 'reports', 'worker.md'), 'out of tree\\n');
    fs.writeFileSync('worker.txt', 'patch\\n');
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"ok","changed":true}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "completed");
  assert.equal(res.breach, false);
  assert.deepEqual(res.breachWarning.escapedPaths, ["reports/"]);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_BREACH_EXEMPT_PATHS;
  delete process.env.AC_ESCAPE;
});

test("a worker that commits directly onto the live checkout (clean tree, HEAD moved) is flagged as a breach (#821)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'commit', '--allow-empty', '-q', '-m', 'escaped commit'], { stdio: 'ignore' });
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"x","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach", "a clean-tree commit onto the live checkout must still override 'completed'");
  assert.equal(res.breach, true);
  assert.match(res.errors.join(" "), /HEAD moved|breach/i);
  assert.match(
    res.escapedPaths.join(" "),
    /not ancestor of upstream; worker likely committed directly/
  );

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_ESCAPE;
});

test("a worker that commits directly onto the live checkout is a hard breach even with AGENT_COLLAB_BREACH_WARN_CONCURRENT=on (#821)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT = "on";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'commit', '--allow-empty', '-q', '-m', 'escaped commit'], { stdio: 'ignore' });
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"x","changed":true}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach", "clean-tree-commit escape is not eligible for the warnConcurrent downgrade");
  assert.equal(res.breach, true);
  assert.equal(res.breachWarning, undefined);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT;
  delete process.env.AC_ESCAPE;
});

function makeRepoWithUpstream() {
  const repo = makeRepo();
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bare-"));
  git(["clone", "--bare", "-q", repo, bare]);
  git(["-C", repo, "remote", "add", "origin", bare]);
  git(["-C", repo, "push", "-q", "-u", "origin", "HEAD:main"]);
  return { repo, bare };
}

test("a sibling fast-forward of the tracked remote is not a headMoved breach (#1044)", () => {
  isolateStateRoot();
  const { repo, bare } = makeRepoWithUpstream();
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sib-"));
  git(["clone", "-q", bare, sibling]);
  git(["-C", sibling, "config", "user.email", "t@example.com"]);
  git(["-C", sibling, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(sibling, "sibling.txt"), "ff\n");
  git(["-C", sibling, "add", "-A"]);
  git(["-C", sibling, "commit", "-q", "-m", "sibling merge"]);
  git(["-C", sibling, "push", "-q", "origin", "HEAD:main"]);

  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'pull', '-q', '--ff-only'], { stdio: 'ignore' });
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"ok","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.breach, false, "picking up origin/main via FF must not be a containment breach");
  assert.notEqual(res.status, "breach");
  assert.deepEqual(res.escapedPaths || [], []);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_ESCAPE;
});

test("a live-checkout commit is still a breach when origin exists but does not contain the new HEAD (#821/#1044)", () => {
  isolateStateRoot();
  const { repo } = makeRepoWithUpstream();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'commit', '--allow-empty', '-q', '-m', 'escaped commit'], { stdio: 'ignore' });
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"x","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach", "a commit that is not on origin/<branch> must still be a hard breach");
  assert.equal(res.breach, true);
  assert.match(
    res.escapedPaths.join(" "),
    /not ancestor of origin\/main; worker likely committed directly/
  );

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_ESCAPE;
});

test("a live-checkout commit is still a hard breach when only AGENT_COLLAB_BREACH_EXEMPT_PATHS files are dirty (#1044 review)", () => {
  isolateStateRoot();
  const { repo } = makeRepoWithUpstream();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_BREACH_EXEMPT_PATHS = "reports/";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'commit', '--allow-empty', '-q', '-m', 'escaped commit'], { stdio: 'ignore' });
    fs.mkdirSync(path.join(process.env.AC_ESCAPE, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(process.env.AC_ESCAPE, 'reports', 'worker.md'), 'exempt dirty\\n');
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"x","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach", "exempt dirty files must not swallow a non-ancestor HEAD move");
  assert.equal(res.breach, true);
  assert.equal(res.breachWarning, undefined, "hard breach must not also emit a soft-only warning/note");
  assert.equal(/not a hard breach/.test(res.note || ""), false);
  assert.match(
    res.escapedPaths.join(" "),
    /not ancestor of origin\/main; worker likely committed directly/
  );

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_BREACH_EXEMPT_PATHS;
  delete process.env.AC_ESCAPE;
});

test("a live-checkout commit that is then pushed to origin is still a hard breach (#1044 review)", () => {
  isolateStateRoot();
  const { repo } = makeRepoWithUpstream();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'commit', '--allow-empty', '-q', '-m', 'escaped commit'], { stdio: 'ignore' });
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'push', '-q', 'origin', 'HEAD:main'], { stdio: 'ignore' });
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"x","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach", "pushing a live-checkout commit to @{u} must not look like a sibling FF");
  assert.equal(res.breach, true);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_ESCAPE;
});

test("commit+push then reset then pull is still a hard breach (#1044 review)", () => {
  isolateStateRoot();
  const { repo } = makeRepoWithUpstream();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    const start = execFileSync('git', ['-C', process.env.AC_ESCAPE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'commit', '--allow-empty', '-q', '-m', 'escaped commit'], { stdio: 'ignore' });
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'push', '-q', 'origin', 'HEAD:main'], { stdio: 'ignore' });
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'reset', '--hard', '-q', start], { stdio: 'ignore' });
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'pull', '-q', '--ff-only'], { stdio: 'ignore' });
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"x","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach", "a concealed live commit in the worker reflog window must still hard-breach");
  assert.equal(res.breach, true);
  assert.equal(res.breachWarning, undefined);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_ESCAPE;
});

test("reset --hard to an upstream ancestor is still a hard breach (#1044 review)", () => {
  isolateStateRoot();
  const { repo } = makeRepoWithUpstream();
  const older = git(["rev-parse", "HEAD"], repo).trim();
  fs.writeFileSync(path.join(repo, "later.txt"), "on origin\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "later on origin"], repo);
  git(["push", "-q", "origin", "HEAD:main"], repo);
  process.env.AC_ESCAPE = repo;
  process.env.AC_RESET_TO = older;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'reset', '--hard', '-q', process.env.AC_RESET_TO], { stdio: 'ignore' });
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"x","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "breach", "rewinding HEAD onto an upstream ancestor is not a sibling FF");
  assert.equal(res.breach, true);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_ESCAPE;
  delete process.env.AC_RESET_TO;
});

test("sibling FF plus a disjoint concurrent dirty file is a breachWarning under AGENT_COLLAB_BREACH_WARN_CONCURRENT=on (#1044 review)", () => {
  isolateStateRoot();
  const { repo, bare } = makeRepoWithUpstream();
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sib-"));
  git(["clone", "-q", bare, sibling]);
  git(["-C", sibling, "config", "user.email", "t@example.com"]);
  git(["-C", sibling, "config", "user.name", "Test"]);
  fs.writeFileSync(path.join(sibling, "sibling.txt"), "ff\n");
  git(["-C", sibling, "add", "-A"]);
  git(["-C", sibling, "commit", "-q", "-m", "sibling merge"]);
  git(["-C", sibling, "push", "-q", "origin", "HEAD:main"]);

  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT = "on";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'pull', '-q', '--ff-only'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(process.env.AC_ESCAPE, 'unrelated-dirty.txt'), 'concurrent\\n');
    fs.writeFileSync('worker.txt', 'patch\\n');
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"ok","changed":true}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.notEqual(res.status, "breach", "benign FF must not disqualify the concurrent-edit downgrade");
  assert.equal(res.breach, false);
  assert.ok(res.breachWarning?.escapedPaths?.some((p) => /unrelated-dirty\.txt/.test(p)));
  assert.equal((res.escapedPaths || []).length, 0);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT;
  delete process.env.AC_ESCAPE;
});

test("a worker that commits AND leaves a disjoint dirty file is still a hard breach under AGENT_COLLAB_BREACH_WARN_CONCURRENT=on (#821 review finding)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AC_ESCAPE = repo;
  process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT = "on";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    import path from 'node:path';
    import { execFileSync } from 'node:child_process';
    if (process.argv.includes('models')) { process.exit(0); }
    execFileSync('git', ['-C', process.env.AC_ESCAPE, 'commit', '--allow-empty', '-q', '-m', 'escaped commit'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(process.env.AC_ESCAPE, 'unrelated-dirty.txt'), 'not part of the patch\\n');
    fs.writeFileSync('worker.txt', 'patch\\n');
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"ok","changed":true}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  // Before the fix, headMoved being true could satisfy `(headMoved || disjointFromPatch)`
  // and downgrade this to a breachWarning — exactly because it's disjoint from the patch.
  // A moved HEAD must never be eligible for the downgrade, regardless of what else escaped.
  assert.equal(res.status, "breach", "a moved HEAD must never be downgraded, even alongside a disjoint dirty file");
  assert.equal(res.breach, true);
  assert.equal(res.breachWarning, undefined);
  assert.ok(res.escapedPaths.some((p) => /unrelated-dirty\.txt/.test(p)));

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_BREACH_WARN_CONCURRENT;
  delete process.env.AC_ESCAPE;
});

test("a queued background job re-snapshots the breach baseline after acquiring its slot, not at launch time (#821 review finding)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_MAX_CONCURRENT_AGY = "1";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"x","changed":false}\\n\`\`\`');
  `);

  // Pre-occupy the only agy slot with a live holder (this process's own pid, so
  // acquireHarnessSlot's dead-pid reclaim never kicks in), so the background job below
  // must queue rather than run immediately.
  const slotDir = path.join(resolveStateDir(repo), "slots", "agy", "slot-1");
  fs.mkdirSync(slotDir, { recursive: true });
  fs.writeFileSync(path.join(slotDir, "pid"), String(process.pid));
  fs.writeFileSync(path.join(slotDir, "job"), "test-holder");

  const launched = launchBackground(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  // Deterministic sync point: acquireHarnessSlot sets status "queued" the moment its
  // first attempt finds every slot busy — wait for that rather than a blind sleep.
  const deadline = Date.now() + 10000;
  while (getJob(repo, launched.jobId)?.status !== "queued" && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.equal(getJob(repo, launched.jobId).status, "queued", "job must actually queue behind the occupied slot");

  // Legitimate driver-side activity landing WHILE the job is queued — exactly what
  // acquireHarnessSlot's wait window allows, and exactly what the launch-time snapshot
  // (captured before this commit even existed) cannot see.
  git(["commit", "--allow-empty", "-q", "-m", "legitimate driver commit while job was queued"], repo);

  // Release the slot so the queued job's next poll (its own 5s cycle) can proceed.
  fs.rmSync(slotDir, { recursive: true, force: true });

  const job = waitForJob(repo, launched.jobId, { timeoutMs: 30000, pollMs: 150 });

  assert.notEqual(job.status, "breach", "a driver commit that landed while queued must not be blamed on this worker");
  assert.equal(job.breach, false);

  delete process.env.AGENT_COLLAB_MAX_CONCURRENT_AGY;
  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("a worker that reports completed but captures NO patch is 'no-changes', not 'completed'", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"did nothing","changed":false}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "no-changes", "an empty deliverable must never read as completed");
  assert.equal(res.changed, false);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("a worker claiming changed:true but capturing nothing gets a diagnostic note", () => {
  isolateStateRoot();
  const repo = makeRepo();
  // self-reports changed:true but writes NOTHING into the worktree.
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    process.stdout.write('\`\`\`json\\n{"status":"completed","summary":"made it","changed":true}\\n\`\`\`');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "x", maxAttempts: 1 });

  assert.equal(res.status, "no-changes");
  assert.match(res.note, /nothing was captured|no patch/i);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("runWorkerSync returns attempts; a reviewer reports no patch (patchApplies null)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(REVIEW_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review" });

  assert.equal(res.attempts, 1);
  assert.equal(res.patchApplies, null);

  delete process.env.AGENT_COLLAB_AGY_BIN;
});

// ---- codex resume-on-failure (continue the thread instead of re-running cold) ----
// The codex adapter runs `node <companion> task --json ...`; AGENT_COLLAB_CODEX_COMPANION
// lets us point it at a stub that mimics codex-companion's envelope + --resume-last.
function codexCompanionStub(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-codexstub-"));
  const p = path.join(dir, "companion.mjs");
  fs.writeFileSync(p, body);
  return p;
}

test("a codex repair attempt RESUMES the thread (task --resume-last) and succeeds", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const marker = path.join(isolateStateRoot(), "resume.marker");
  process.env.AC_MARKER = marker;
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    import fs from 'node:fs';
    if (process.argv.includes('--resume-last')) {
      fs.writeFileSync(process.env.AC_MARKER, 'resumed');
      const review = JSON.stringify({verdict:'approve',summary:'ok',findings:[]});
      process.stdout.write(JSON.stringify({ status: 0, rawOutput: '\`\`\`json\\n' + review + '\\n\`\`\`' }));
    } else {
      process.stdout.write('just prose, no json'); // attempt 1: invalid -> triggers a repair
    }
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "codex", role: "reviewer", brief: "review", maxAttempts: 2 });

  assert.equal(res.status, "completed");
  assert.equal(res.artifact.verdict, "approve");
  assert.equal(fs.readFileSync(marker, "utf8"), "resumed", "the repair used --resume-last");

  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
  delete process.env.AC_MARKER;
});

test("a codex repair falls back to a FRESH re-send when the thread can't be resumed", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const countFile = path.join(isolateStateRoot(), "n.txt");
  process.env.AC_COUNT_FILE = countFile;
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    import fs from 'node:fs';
    const f = process.env.AC_COUNT_FILE;
    const n = (fs.existsSync(f) ? Number(fs.readFileSync(f,'utf8')) : 0) + 1;
    fs.writeFileSync(f, String(n));
    if (process.argv.includes('--resume-last')) {
      process.stderr.write('No previous Codex task thread was found for this repository.');
      process.exit(1);
    } else if (n === 1) {
      process.stdout.write('prose, invalid'); // attempt 1 fresh: invalid
    } else {
      const review = JSON.stringify({verdict:'approve',summary:'ok',findings:[]});
      process.stdout.write(JSON.stringify({ status: 0, rawOutput: '\`\`\`json\\n' + review + '\\n\`\`\`' }));
    }
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "codex", role: "reviewer", brief: "review", maxAttempts: 2 });

  assert.equal(res.status, "completed", "resume missed -> fell back to a fresh re-send");

  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
  delete process.env.AC_COUNT_FILE;
});

test("AGENT_COLLAB_CODEX_RESUME=off repairs with a fresh re-send, never --resume-last", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const marker = path.join(isolateStateRoot(), "rl.marker");
  const countFile = path.join(isolateStateRoot(), "n.txt");
  process.env.AC_MARKER = marker;
  process.env.AC_COUNT_FILE = countFile;
  process.env.AGENT_COLLAB_CODEX_RESUME = "off";
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    import fs from 'node:fs';
    if (process.argv.includes('--resume-last')) fs.writeFileSync(process.env.AC_MARKER, 'x');
    const f = process.env.AC_COUNT_FILE;
    const n = (fs.existsSync(f) ? Number(fs.readFileSync(f,'utf8')) : 0) + 1;
    fs.writeFileSync(f, String(n));
    if (n === 1) {
      process.stdout.write('prose');
    } else {
      const review = JSON.stringify({verdict:'approve',summary:'ok',findings:[]});
      process.stdout.write(JSON.stringify({ status: 0, rawOutput: '\`\`\`json\\n' + review + '\\n\`\`\`' }));
    }
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "codex", role: "reviewer", brief: "review", maxAttempts: 2 });

  assert.equal(res.status, "completed");
  assert.equal(fs.existsSync(marker), false, "resume disabled -> never used --resume-last");

  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
  delete process.env.AGENT_COLLAB_CODEX_RESUME;
  delete process.env.AC_MARKER;
  delete process.env.AC_COUNT_FILE;
});

test("runWithFallback surfaces a clear note when ALL workers are limited", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(RATE_LIMITED_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(RATE_LIMITED_STUB);

  const res = runWithFallback(repo, {
    driver: "codex",
    worker: "agy",
    role: "worker",
    brief: "x",
    available: ["agy", "claude"],
    maxAttempts: 1
  });

  assert.equal(res.status, "failed");
  assert.equal(res.allWorkersLimited, true);
  assert.equal(res.fellBackFrom.length, 2);
  assert.match(res.note, /limit/i);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("resolveFallbackKinds: default is transient-only; off/on/list configurable", () => {
  const base = { ...process.env };
  delete process.env.AGENT_COLLAB_FALLBACK;
  let k = resolveFallbackKinds(process.env);
  assert.ok(k.has("rate-limit") && k.has("timeout"));
  assert.equal(k.has("auth"), false, "auth is NOT in the default policy (it surfaces)");

  assert.equal(resolveFallbackKinds({ AGENT_COLLAB_FALLBACK: "off" }).size, 0);
  assert.equal(resolveFallbackKinds({ AGENT_COLLAB_FALLBACK: "on" }).has("auth"), true);
  const only = resolveFallbackKinds({ AGENT_COLLAB_FALLBACK: "rate-limit" });
  assert.ok(only.has("rate-limit") && !only.has("timeout"));

  process.env = base;
});

test("auth does NOT auto-fall-back by default (it surfaces the chosen worker's auth failure)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    process.stderr.write('401 Unauthorized: invalid api key\\n'); process.exit(1);
  `);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex", worker: "agy", role: "worker", brief: "x",
    available: ["agy", "claude"], maxAttempts: 1
  });

  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "auth");
  assert.equal(res.worker, "agy", "stayed on the chosen worker; auth is surfaced, not routed around");
  assert.ok(!res.fellBackFrom);

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("auth DOES fall back when the policy opts in (fallbackKinds includes auth)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    if (process.argv.includes('models')) { process.exit(0); }
    process.stderr.write('401 Unauthorized\\n'); process.exit(1);
  `);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex", worker: "agy", role: "worker", brief: "x",
    available: ["agy", "claude"], maxAttempts: 1,
    fallbackKinds: new Set(["rate-limit", "auth", "timeout"])
  });

  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("runWithFallback does NOT fall back on an ordinary (non-limit) failure", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(NOOP_WORKER_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex",
    worker: "agy",
    role: "worker",
    brief: "x",
    available: ["agy", "claude"],
    maxAttempts: 1
  });

  assert.equal(res.status, "failed");
  assert.equal(res.worker, "agy", "stayed on the originally-chosen worker");
  assert.ok(!res.fellBackFrom, "no fallback chain for a genuine task failure");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("runWithFallback honors fallback=false (single-worker, surface the limit)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(RATE_LIMITED_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "codex",
    worker: "agy",
    role: "worker",
    brief: "x",
    available: ["agy", "claude"],
    fallback: false,
    maxAttempts: 1
  });

  assert.equal(res.status, "failed");
  assert.equal(res.worker, "agy");
  assert.equal(res.failureKind, "rate-limit");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});

test("worker runs still retry on malformed output then fail after maxAttempts", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const countFile = path.join(isolateStateRoot(), "count.txt");
  process.env.AC_COUNT_FILE = countFile;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(`
    import fs from 'node:fs';
    // The reviewer path lists models first; don't count that as a task attempt.
    if (process.argv.includes('models')) { process.stdout.write('Gemini 3.5 Flash (High)'); process.exit(0); }
    const f = process.env.AC_COUNT_FILE;
    const n = (fs.existsSync(f) ? Number(fs.readFileSync(f,'utf8')) : 0) + 1;
    fs.writeFileSync(f, String(n));
    process.stdout.write('no json here, just prose');
  `);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "review", maxAttempts: 2 });

  assert.equal(res.valid, false);
  assert.equal(res.status, "failed");
  assert.equal(Number(fs.readFileSync(countFile, "utf8")), 2, "retried exactly maxAttempts times");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_COUNT_FILE;
});

test("runWorkerSync uses MODEL_PROFILES[worker].idleMsOverride when idleMs isn't explicitly passed", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const original = MODEL_PROFILES.claude.idleMsOverride;
  MODEL_PROFILES.claude.idleMsOverride = 800;
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(
    `if (process.argv.includes('models')) process.exit(0); await new Promise(r=>setTimeout(r,4000)); process.stdout.write('late');`
  );

  const res = runWorkerSync(repo, { driver: "codex", worker: "claude", role: "worker", brief: "x", timeoutMs: 60000 });
  assert.equal(res.status, "failed");
  assert.equal(res.failureKind, "frozen");

  MODEL_PROFILES.claude.idleMsOverride = original;
  delete process.env.AGENT_COLLAB_CLAUDE_BIN;
});
