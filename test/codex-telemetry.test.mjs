// Codex turn telemetry: resolvedModel/effort come from the completed turn's
// `turn_context` record in the Codex rollout, bound through the companion's
// job record under the job's artifactDir. Every ambiguity fails closed to null.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAdapter } from "../adapters/index.mjs";
import { runWorkerSync } from "../core/dispatch.mjs";
import { getJob } from "../core/state.mjs";
import { makeRepo, isolateStateRoot, real } from "./helpers.mjs";

const THREAD = "01a1344a-cf0a-7510-b1a0-bd9562985639";
const TURN = "01a1344a-d5c1-79c3-bd08-59c5060d7a48";
const OTHER_TURN = "01a1344a-d5c1-79c3-bd08-59c5060d7a49";
const COMPLETED_AT = "2026-10-13T08:00:00.000Z";
const ANSWER = '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}';

function tmp(prefix) {
  return real(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeJob(artifactDir, name, job, slug = "ws-1234") {
  const dir = path.join(artifactDir, "codex-companion", "state", slug, "jobs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, typeof job === "string" ? job : JSON.stringify(job));
  return file;
}

function completedJob(over = {}) {
  return { id: "task-1", status: "completed", threadId: THREAD, turnId: TURN, completedAt: COMPLETED_AT, ...over };
}

function turnContext(over = {}, settings = { model: "gpt-5.6-luna", reasoning_effort: "medium" }) {
  return JSON.stringify({
    timestamp: COMPLETED_AT,
    type: "turn_context",
    payload: {
      turn_id: TURN,
      model: "gpt-5.6-luna",
      effort: "medium",
      collaboration_mode: { mode: "default", settings },
      ...over
    }
  });
}

function writeRollout(home, lines, { day = "2026/10/13", stamp = "2026-10-13T08-00-00", thread = THREAD } = {}) {
  const dir = path.join(home, "sessions", ...day.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${stamp}-${thread}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function envelope(over = {}) {
  return JSON.stringify({ status: 0, threadId: THREAD, rawOutput: ANSWER, touchedFiles: [], reasoningSummary: [], ...over });
}

function parse({ artifactDir, home, stdout = envelope() }) {
  return getAdapter("codex").parseOutput({ stdout, artifactDir, env: home ? { CODEX_HOME: home } : {} });
}

function fixture() {
  const artifactDir = tmp("ac-codex-art-");
  const home = tmp("ac-codex-home-");
  return { artifactDir, home };
}

test("codex telemetry binds model and effort from the completed turn's turn_context", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [
    JSON.stringify({ type: "session_meta", payload: { id: THREAD } }),
    turnContext(),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message" } })
  ]);
  const r = parse({ artifactDir, home });
  assert.equal(r.answerText, ANSWER);
  assert.deepEqual(r.telemetry, { threadId: THREAD, turnId: TURN, resolvedModel: "gpt-5.6-luna", effort: "medium" });
});

test("codex envelope telemetry always carries an effort key (subsumes the envelope effort stopgap)", () => {
  const r = getAdapter("codex").parseOutput({ stdout: envelope() });
  assert.ok(r.telemetry && Object.prototype.hasOwnProperty.call(r.telemetry, "effort"), "telemetry.effort key missing");
  assert.equal(r.telemetry.effort, null);
  assert.equal(r.telemetry.resolvedModel, null);
  assert.equal(r.telemetry.threadId, THREAD);
});

test("codex telemetry never trusts model/effort claimed by the envelope", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const r = parse({ artifactDir, home, stdout: envelope({ model: "gpt-claimed", effort: "xhigh" }) });
  assert.equal(r.telemetry.resolvedModel, null);
  assert.equal(r.telemetry.effort, null);
  assert.equal(r.telemetry.turnId, TURN);
});

test("codex telemetry is null/null when no rollout file exists for the thread", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const r = parse({ artifactDir, home });
  assert.deepEqual(r.telemetry, { threadId: THREAD, turnId: TURN, resolvedModel: null, effort: null });
});

test("codex telemetry is null when two rollout files match the thread", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  writeRollout(home, [turnContext()], { day: "2026/10/14", stamp: "2026-10-14T08-00-00" });
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, null);
  assert.equal(r.telemetry.effort, null);
});

test("codex telemetry is null when two completed jobs share the latest completedAt with different turnIds", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeJob(artifactDir, "task-2", completedJob({ id: "task-2", turnId: OTHER_TURN }));
  writeRollout(home, [turnContext(), turnContext({ turn_id: OTHER_TURN })]);
  const r = parse({ artifactDir, home });
  assert.deepEqual(r.telemetry, { threadId: THREAD, turnId: null, resolvedModel: null, effort: null });
});

test("codex telemetry is null when the thread has two completed jobs, even if the later one has an EARLIER completedAt", () => {
  const { artifactDir, home } = fixture();
  // Wall-clock rollback: the second (later) attempt carries the earlier stamp.
  writeJob(artifactDir, "task-1", completedJob());
  writeJob(artifactDir, "task-2", completedJob({ id: "task-2", turnId: OTHER_TURN, completedAt: "2026-10-13T07:00:00.000Z" }));
  writeRollout(home, [turnContext(), turnContext({ turn_id: OTHER_TURN, model: "gpt-6-luna", effort: "xhigh" }, {})]);
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, null, "two same-thread jobs must not be ordered by wall clock");
  assert.equal(r.telemetry.effort, null);
  assert.equal(r.telemetry.turnId, null);
});

test("codex telemetry is null when artifactDir holds any second companion job (a repair attempt on another thread)", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeJob(artifactDir, "task-0", { id: "task-0", status: "failed", threadId: "01a1344a-cf0a-7510-b1a0-bd95629856ff" });
  writeRollout(home, [turnContext()]);
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, null, "a job with a repair attempt must not bind");
  assert.equal(r.telemetry.effort, null);
});

test("codex telemetry ignores a job record outside artifactDir (sibling dir or symlink escape)", () => {
  const { artifactDir, home } = fixture();
  writeRollout(home, [turnContext()]);
  // A job record for the same thread in another job's artifact dir is never read.
  const sibling = tmp("ac-codex-sibling-");
  const outside = writeJob(sibling, "task-1", completedJob());
  assert.deepEqual(parse({ artifactDir, home }).telemetry.resolvedModel, null);
  // A symlink inside artifactDir that points outside it is not followed.
  const jobsDir = path.join(artifactDir, "codex-companion", "state", "ws-1234", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.symlinkSync(outside, path.join(jobsDir, "task-1.json"));
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.turnId, null);
  assert.equal(r.telemetry.resolvedModel, null);
  assert.equal(r.telemetry.effort, null);
});

test("codex telemetry fails closed on a malformed job file even when a valid one exists", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "broken", "{not json");
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  const r = parse({ artifactDir, home });
  assert.deepEqual(r.telemetry, { threadId: THREAD, turnId: null, resolvedModel: null, effort: null });
});

test("codex telemetry skips a malformed rollout line that is not a turn_context record", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, ["{not json at all", turnContext()]);
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
  assert.equal(r.telemetry.effort, "medium");
});

test("codex telemetry fails closed on a malformed or truncated turn_context record", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const full = turnContext();
  writeRollout(home, [full, '{"timestamp":"2026-10-13T08:00:01.000Z","type":"turn_context","payload":{"turn_id":"x"']);
  assert.equal(parse({ artifactDir, home }).telemetry.resolvedModel, null, "malformed turn_context line must be ambiguous");
  const second = fixture();
  writeJob(second.artifactDir, "task-1", completedJob());
  // A rollout truncated in the middle of the turn's own turn_context record.
  const file = writeRollout(second.home, [full]);
  fs.writeFileSync(file, full.slice(0, Math.floor(full.length / 2)));
  const r = parse(second);
  assert.equal(r.telemetry.resolvedModel, null, "truncated rollout must be ambiguous");
  assert.equal(r.telemetry.effort, null);
});

const ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test("codex telemetry fails closed when a sessions directory cannot be read", { skip: ROOT && "root ignores mode bits" }, () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  const blocked = path.join(home, "sessions", "2026", "09");
  fs.mkdirSync(blocked, { recursive: true });
  fs.chmodSync(blocked, 0o000);
  try {
    const r = parse({ artifactDir, home });
    assert.equal(r.telemetry.resolvedModel, null);
    assert.equal(r.telemetry.effort, null);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }
});

test("codex telemetry fails closed when a companion jobs directory cannot be read", { skip: ROOT && "root ignores mode bits" }, () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  const blocked = path.join(artifactDir, "codex-companion", "state", "ws-other", "jobs");
  fs.mkdirSync(blocked, { recursive: true });
  fs.chmodSync(blocked, 0o000);
  try {
    const r = parse({ artifactDir, home });
    assert.equal(r.telemetry.turnId, null);
    assert.equal(r.telemetry.resolvedModel, null);
  } finally {
    fs.chmodSync(blocked, 0o755);
  }
});

test("codex telemetry rejects a rollout symlink that escapes the sessions root", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const elsewhere = tmp("ac-codex-elsewhere-");
  const outside = path.join(elsewhere, "rollout.jsonl");
  fs.writeFileSync(outside, turnContext() + "\n");
  const day = path.join(home, "sessions", "2026", "10", "13");
  fs.mkdirSync(day, { recursive: true });
  fs.symlinkSync(outside, path.join(day, `rollout-2026-10-13T08-00-00-${THREAD}.jsonl`));
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, null);
  assert.equal(r.telemetry.effort, null);
});

test("codex telemetry follows a symlinked sessions directory", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const store = tmp("ac-codex-store-");
  writeRollout(store, [turnContext()]);
  fs.symlinkSync(path.join(store, "sessions"), path.join(home, "sessions"));
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
  assert.equal(r.telemetry.effort, "medium");
});

test("codex telemetry refuses a rollout over the 1 GiB cap without reading it", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const file = writeRollout(home, [turnContext()]);
  fs.truncateSync(file, 1024 * 1024 * 1024 + 1); // sparse: no real disk use
  const readSync = mock.method(fs, "readSync");
  const readFileSync = mock.method(fs, "readFileSync");
  try {
    const r = parse({ artifactDir, home });
    assert.equal(r.telemetry.resolvedModel, null);
    assert.equal(r.telemetry.effort, null);
    assert.equal(readFileSync.mock.calls.some((c) => String(c.arguments[0]) === file), false, "the rollout must not be read whole");
    assert.equal(readSync.mock.calls.length, 0, "no rollout bytes may be read over the cap");
  } finally {
    readSync.mock.restore();
    readFileSync.mock.restore();
  }
});

test("codex telemetry binds a 100 MiB rollout (real sessions reach 111 MB)", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const file = writeRollout(home, [turnContext()]);
  fs.truncateSync(file, 100 * 1024 * 1024); // sparse tail, one huge NUL line
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
  assert.equal(r.telemetry.effort, "medium");
});

test("codex telemetry reads a rollout under the cap in bounded chunks, never whole", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const filler = JSON.stringify({ type: "event_msg", payload: { text: "x".repeat(4096) } });
  const file = writeRollout(home, [turnContext(), ...Array(600).fill(filler)]); // ~2.4 MiB
  const readFileSync = mock.method(fs, "readFileSync");
  try {
    const r = parse({ artifactDir, home });
    assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
    assert.equal(readFileSync.mock.calls.some((c) => String(c.arguments[0]) === file), false);
  } finally {
    readFileSync.mock.restore();
  }
});

test("codex telemetry uses the spawn env CODEX_HOME over a conflicting ambient seat home", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  const ambient = tmp("ac-codex-ambient-");
  writeRollout(ambient, [turnContext({ model: "gpt-other-seat", effort: "low" }, {})]);
  const saved = { CODEX_HOME: process.env.CODEX_HOME, AGENT_COLLAB_CODEX_HOME: process.env.AGENT_COLLAB_CODEX_HOME };
  process.env.CODEX_HOME = ambient;
  process.env.AGENT_COLLAB_CODEX_HOME = ambient;
  try {
    const r = parse({ artifactDir, home });
    assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
    assert.equal(r.telemetry.effort, "medium");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

function withReaddirEnoent(target, fn) {
  const real = fs.readdirSync;
  const spy = mock.method(fs, "readdirSync", function (dir, ...rest) {
    if (String(dir) === target) {
      const err = new Error(`ENOENT: no such file or directory, scandir '${target}'`);
      err.code = "ENOENT";
      throw err;
    }
    return real.call(fs, dir, ...rest);
  });
  try {
    return fn();
  } finally {
    spy.mock.restore();
  }
}

test("codex telemetry fails closed when a sessions child vanishes after its parent was listed", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  const other = path.join(home, "sessions", "2026", "10", "14");
  fs.mkdirSync(other, { recursive: true });
  const r = withReaddirEnoent(other, () => parse({ artifactDir, home }));
  assert.equal(r.telemetry.resolvedModel, null, "ENOENT on a listed child is an incomplete scan");
  assert.equal(r.telemetry.effort, null);
});

test("codex telemetry fails closed when a companion jobs directory vanishes after its slug was listed", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  const slug = path.join(artifactDir, "codex-companion", "state", "ws-other");
  fs.mkdirSync(slug, { recursive: true });
  const r = withReaddirEnoent(path.join(slug, "jobs"), () => parse({ artifactDir, home }));
  assert.equal(r.telemetry.resolvedModel, null, "ENOENT on a listed slug's jobs dir is an incomplete scan");
});

test("codex telemetry is null/null when the companion state root does not exist", () => {
  const { artifactDir, home } = fixture();
  writeRollout(home, [turnContext()]);
  assert.deepEqual(parse({ artifactDir, home }).telemetry, { threadId: THREAD, turnId: null, resolvedModel: null, effort: null });
});

test("codex telemetry recognises turn_context independent of JSON whitespace and key order", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const payload = {
    turn_id: TURN, model: "gpt-5.6-luna", effort: "medium",
    collaboration_mode: { settings: { model: "gpt-5.6-luna", reasoning_effort: "medium" } },
    cwd: "/x/" + "p".repeat(400)
  };
  // Payload first pushes the record kind far past the line head; spaces around ':'.
  const spaced = `{"payload" : ${JSON.stringify(payload)}, "timestamp" : "${COMPLETED_AT}", "type" : "turn_context"}`;
  writeRollout(home, [spaced]);
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
  assert.equal(r.telemetry.effort, "medium");
});

test("codex telemetry fails closed on a malformed whitespace-variant turn_context candidate", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext(), '{"timestamp": "x", "type" :  "turn_context", "payload": {"turn_id": ']);
  assert.equal(parse({ artifactDir, home }).telemetry.resolvedModel, null);
});

test("codex telemetry does not mistake an escaped turn_context mention in tool output for a record", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  const mention = JSON.stringify({ type: "response_item", payload: { text: 'grep \'"type":"turn_context"\' broken {' } });
  writeRollout(home, [mention, turnContext()]);
  assert.equal(parse({ artifactDir, home }).telemetry.resolvedModel, "gpt-5.6-luna");
});

test("codex telemetry fails closed on a turn_context with an array payload or no turn_id", () => {
  const first = fixture();
  writeJob(first.artifactDir, "task-1", completedJob());
  writeRollout(first.home, [turnContext(), JSON.stringify({ timestamp: COMPLETED_AT, type: "turn_context", payload: [TURN] })]);
  assert.equal(parse(first).telemetry.resolvedModel, null, "array payload must be ambiguous");
  const second = fixture();
  writeJob(second.artifactDir, "task-1", completedJob());
  writeRollout(second.home, [turnContext(), JSON.stringify({ timestamp: COMPLETED_AT, type: "turn_context", payload: { model: "gpt-x", effort: "low" } })]);
  assert.equal(parse(second).telemetry.resolvedModel, null, "turn_context without turn_id must be ambiguous");
});

test("codex output-form and plain-text results carry explicit null telemetry", () => {
  const codex = getAdapter("codex");
  const outputForm = codex.parseOutput({ stdout: JSON.stringify({ output: ANSWER }) });
  assert.equal(outputForm.answerText, ANSWER);
  assert.deepEqual(outputForm.telemetry, { threadId: null, turnId: null, resolvedModel: null, effort: null });
  const plain = codex.parseOutput({ stdout: "plain words, no envelope" });
  assert.deepEqual(plain.telemetry, { threadId: null, turnId: null, resolvedModel: null, effort: null });
});

test("codex output-form result with a thread id resolves its turn like the envelope", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  const r = parse({ artifactDir, home, stdout: JSON.stringify({ output: ANSWER, threadId: THREAD }) });
  assert.equal(r.answerText, ANSWER);
  assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
  assert.equal(r.telemetry.effort, "medium");
});

test("codex telemetry binding never reads completedAt (a single job binds without one)", () => {
  const { artifactDir, home } = fixture();
  const { completedAt, ...noStamp } = completedJob();
  writeJob(artifactDir, "task-1", noStamp);
  writeRollout(home, [turnContext()]);
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
  assert.equal(r.telemetry.effort, "medium");
});

test("codex telemetry is null when turn_context disagrees with its collaboration_mode settings", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext({}, { model: "gpt-5.6-luna", reasoning_effort: "high" })]);
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.turnId, TURN);
  assert.equal(r.telemetry.effort, null);
  assert.equal(r.telemetry.resolvedModel, null);
});

test("codex telemetry is null when two turn_context records for the turn disagree", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext(), turnContext({ effort: "high" }, {})]);
  assert.equal(parse({ artifactDir, home }).telemetry.effort, null);
});

test("codex telemetry is null for a non-UUID threadId or a missing artifactDir", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, [turnContext()]);
  assert.deepEqual(parse({ artifactDir, home, stdout: envelope({ threadId: "t" }) }).telemetry,
    { threadId: null, turnId: null, resolvedModel: null, effort: null });
  assert.deepEqual(parse({ artifactDir: undefined, home }).telemetry,
    { threadId: THREAD, turnId: null, resolvedModel: null, effort: null });
});

const THREAD2 = "01a1344a-cf0a-7510-b1a0-bd9562985640";
const TURN2 = "01a1344a-d5c1-79c3-bd08-59c5060d7a50";
const LATER = "2026-10-13T09:00:00.000Z";
const INVALID = '{"verdict":"maybe"}';

// Runs runWorkerSync against a stub companion. Each attempt (1-based) writes
// its job record under CLAUDE_PLUGIN_DATA (as the real companion does, scoped
// by the adapter to <artifactDir>/codex-companion) and prints its stdout.
// CODEX_HOME is a temp dir on every path, so the real ~/.codex is never read.
function runCodexStub(plan, { rollouts = [] } = {}) {
  isolateStateRoot();
  const repo = makeRepo();
  const home = tmp("ac-codex-home-");
  for (const r of rollouts) writeRollout(home, r.lines, r.opts);
  const keys = ["HOME", "CODEX_HOME", "AGENT_COLLAB_CODEX_HOME", "AGENT_COLLAB_CODEX_COMPANION"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = tmp("ac-home-");
  process.env.CODEX_HOME = home;
  process.env.AGENT_COLLAB_CODEX_HOME = home;
  const stubDir = tmp("ac-codexstub-");
  const planFile = path.join(stubDir, "plan.json");
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const stub = path.join(stubDir, "companion.mjs");
  fs.writeFileSync(stub, `
    import fs from 'node:fs';
    import path from 'node:path';
    const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, 'utf8'));
    const counter = ${JSON.stringify(path.join(stubDir, "count"))};
    let n = 0;
    try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch {}
    fs.writeFileSync(counter, String(n + 1));
    const step = plan[Math.min(n, plan.length - 1)];
    if (step.job) {
      const jobs = path.join(process.env.CLAUDE_PLUGIN_DATA, 'state', 'ws-1234', 'jobs');
      fs.mkdirSync(jobs, { recursive: true });
      fs.writeFileSync(path.join(jobs, 'task-' + (n + 1) + '.json'), JSON.stringify(step.job));
    }
    process.stdout.write(step.stdout);
  `);
  process.env.AGENT_COLLAB_CODEX_COMPANION = stub;
  try {
    const res = runWorkerSync(repo, {
      driver: "claude", worker: "codex", role: "reviewer", brief: "review",
      maxAttempts: plan.length, noResume: true
    });
    return { res, job: getJob(repo, res.jobId), attempts: Number(fs.readFileSync(path.join(stubDir, "count"), "utf8")) };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function assertNullAttribution({ res, job }) {
  assert.equal(res.resolvedModel, null, "result resolvedModel inherited from an earlier attempt");
  assert.equal(res.workerTelemetry?.effort ?? null, null, "result effort inherited from an earlier attempt");
  assert.equal(res.workerTelemetry?.resolvedModel ?? null, null);
  assert.equal(job.resolvedModel, null, "job record resolvedModel inherited from an earlier attempt");
  assert.equal(job.workerTelemetry?.effort ?? null, null, "job record effort inherited from an earlier attempt");
}

const ATTEMPT1_BOUND = { job: completedJob(), stdout: envelope({ rawOutput: INVALID }) };

test("runWorkerSync passes artifactDir and the spawn env to parseOutput (telemetry lands on the job)", () => {
  const { res, job } = runCodexStub([{ job: completedJob(), stdout: envelope() }], { rollouts: [{ lines: [turnContext()] }] });
  assert.equal(res.status, "completed");
  assert.equal(res.resolvedModel, "gpt-5.6-luna");
  assert.equal(res.workerTelemetry?.effort, "medium");
  assert.equal(res.workerTelemetry?.turnId, TURN);
  assert.equal(job.resolvedModel, "gpt-5.6-luna");
  assert.equal(job.workerTelemetry?.effort, "medium");
});

test("a codex repair whose final response has no usable turn context records null, not attempt 1's values", () => {
  const out = runCodexStub(
    [ATTEMPT1_BOUND, { job: completedJob({ id: "task-2", threadId: THREAD2, turnId: TURN2, completedAt: LATER }), stdout: envelope({ threadId: THREAD2 }) }],
    { rollouts: [{ lines: [turnContext()] }] } // no rollout for THREAD2
  );
  assert.equal(out.attempts, 2);
  assert.equal(out.res.status, "completed");
  assertNullAttribution(out);
});

test("a codex repair whose final response uses the output form records null, not attempt 1's values", () => {
  const out = runCodexStub([ATTEMPT1_BOUND, { stdout: JSON.stringify({ output: ANSWER }) }], { rollouts: [{ lines: [turnContext()] }] });
  assert.equal(out.attempts, 2);
  assert.equal(out.res.status, "completed");
  assertNullAttribution(out);
});

test("a codex repair whose final response is plain text records null, not attempt 1's values", () => {
  const out = runCodexStub([ATTEMPT1_BOUND, { stdout: ANSWER }], { rollouts: [{ lines: [turnContext()] }] });
  assert.equal(out.attempts, 2);
  assert.equal(out.res.status, "completed");
  assertNullAttribution(out);
});

test("a codex repair is never turn-bound, even when attempt 2 has its own bound turn", () => {
  const out = runCodexStub(
    [ATTEMPT1_BOUND, { job: completedJob({ id: "task-2", threadId: THREAD2, turnId: TURN2, completedAt: LATER }), stdout: envelope({ threadId: THREAD2 }) }],
    {
      rollouts: [
        { lines: [turnContext()] },
        { lines: [turnContext({ turn_id: TURN2, model: "gpt-6-luna", effort: "xhigh" }, { model: "gpt-6-luna", reasoning_effort: "xhigh" })], opts: { thread: THREAD2, stamp: "2026-10-13T09-00-00" } }
      ]
    }
  );
  assert.equal(out.attempts, 2);
  assertNullAttribution(out);
});

test("a same-thread codex repair after a clock rollback records null, not attempt 1's turn", () => {
  const out = runCodexStub(
    [ATTEMPT1_BOUND, { job: completedJob({ id: "task-2", turnId: TURN2, completedAt: "2026-10-13T07:00:00.000Z" }), stdout: envelope() }],
    { rollouts: [{ lines: [turnContext(), turnContext({ turn_id: TURN2, model: "gpt-6-luna", effort: "xhigh" }, {})] }] }
  );
  assert.equal(out.attempts, 2);
  assert.equal(out.res.status, "completed");
  assertNullAttribution(out);
});
