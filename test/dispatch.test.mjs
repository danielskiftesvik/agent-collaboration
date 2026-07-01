import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeRepo, isolateStateRoot, stubBin, real, git } from "./helpers.mjs";
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
  defaultTimeoutMs,
  defaultIdleMs,
  applyResult
} from "../core/dispatch.mjs";
import { appendJob, updateJob, getJob } from "../core/state.mjs";
import { MODEL_PROFILES } from "../core/model-profiles.mjs";

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
  MODEL_PROFILES.agy.canWrite = false;
  delete process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);

  const res = runWorkerSync(repo, { driver: "claude", worker: "agy", role: "worker", brief: "make a file" });

  assert.equal(res.status, "blocked");
  assert.equal(res.failureKind, "unsupported-worker");
  assert.match(res.errors.join(" "), /cannot deliver patches/i);
  assert.equal(fs.existsSync(path.join(repo, "worker-was-here.txt")), false);

  MODEL_PROFILES.agy.canWrite = old;
  process.env.AGENT_COLLAB_ALLOW_NONWRITER = "on";
  delete process.env.AGENT_COLLAB_AGY_BIN;
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

test("runWithFallback skips non-writer fallback candidates for write roles", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const old = MODEL_PROFILES.agy.canWrite;
  MODEL_PROFILES.agy.canWrite = false;
  delete process.env.AGENT_COLLAB_ALLOW_NONWRITER;
  process.env.AGENT_COLLAB_CODEX_COMPANION = codexCompanionStub(`
    process.stdout.write(JSON.stringify({
      status: 1,
      rawOutput: JSON.stringify({status:"failed",summary:"429 RESOURCE_EXHAUSTED quota exceeded",changed:false})
    }));
  `);
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(WRITE_STUB);
  process.env.AGENT_COLLAB_CLAUDE_BIN = stubBin(CLAUDE_SUCCESS_STUB);

  const res = runWithFallback(repo, {
    driver: "manual",
    worker: "codex",
    role: "worker",
    brief: "x",
    available: ["codex", "agy", "claude"],
    maxAttempts: 1
  });

  assert.equal(res.status, "completed");
  assert.equal(res.worker, "claude");
  assert.equal(res.fellBackFrom[0].worker, "codex");

  MODEL_PROFILES.agy.canWrite = old;
  process.env.AGENT_COLLAB_ALLOW_NONWRITER = "on";
  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
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
  fs.writeFileSync(process.env.AC_SEEN, JSON.stringify({
    appOnDisk: app.trim(),
    promptSaysApplied: /has been APPLIED to your working tree/.test(prompt),
    promptSaysBaseline: /repository's HEAD baseline/i.test(prompt)
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

test("a review with non-diff input falls back to the pasted-text baseline path", () => {
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
