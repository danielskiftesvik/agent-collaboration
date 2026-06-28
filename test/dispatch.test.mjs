import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeRepo, isolateStateRoot, stubBin } from "./helpers.mjs";
import {
  decideRoute,
  runSetup,
  runWorkerSync,
  runWithFallback,
  defaultTimeoutMs,
  applyResult
} from "../core/dispatch.mjs";

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

const REVIEW_STUB = `
process.stdout.write('\`\`\`json\\n' + JSON.stringify({verdict:'approve',summary:'looks good',findings:[],next_steps:[]}) + '\\n\`\`\`');
`;

test("runWorkerSync (reviewer) validates against the review schema, no patch", () => {
  isolateStateRoot();
  const repo = makeRepo();
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(REVIEW_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review" });

  assert.equal(res.valid, true);
  assert.equal(res.artifact.verdict, "approve");
  assert.equal(fs.existsSync(path.join(res.artifactDir, "patches", "agy.diff")), false);

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

  runWorkerSync(repo, {
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

test("runWorkerSync retries on malformed output then fails after maxAttempts", () => {
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

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "reviewer", brief: "review", maxAttempts: 2 });

  assert.equal(res.valid, false);
  assert.equal(res.status, "failed");
  assert.equal(Number(fs.readFileSync(countFile, "utf8")), 2, "retried exactly maxAttempts times");

  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AC_COUNT_FILE;
});
