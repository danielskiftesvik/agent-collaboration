import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { makeRepo, isolateStateRoot, stubBin } from "./helpers.mjs";
import {
  decideRoute,
  runSetup,
  runWorkerSync,
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
