// Codex turn telemetry: resolvedModel/effort come from the completed turn's
// `turn_context` record in the Codex rollout, bound through the companion's
// job record under the job's artifactDir. Every ambiguity fails closed to null.
import { test } from "node:test";
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

test("codex telemetry picks the latest completed turn when completedAt differs", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob({ completedAt: "2026-10-13T07:00:00.000Z", turnId: OTHER_TURN }));
  writeJob(artifactDir, "task-2", completedJob({ id: "task-2" }));
  writeRollout(home, [turnContext({ turn_id: OTHER_TURN, model: "gpt-old", effort: "low" }, {}), turnContext()]);
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.turnId, TURN);
  assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
  assert.equal(r.telemetry.effort, "medium");
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

test("codex telemetry ignores a malformed job file and binds from the valid one", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "broken", "{not json");
  writeJob(artifactDir, "task-1", completedJob());
  writeRollout(home, ["{not json either", turnContext()]);
  const r = parse({ artifactDir, home });
  assert.equal(r.telemetry.resolvedModel, "gpt-5.6-luna");
  assert.equal(r.telemetry.effort, "medium");
});

test("codex telemetry fails closed when the completed job has no completedAt", () => {
  const { artifactDir, home } = fixture();
  const { completedAt, ...noStamp } = completedJob();
  writeJob(artifactDir, "task-1", noStamp);
  writeRollout(home, [turnContext()]);
  const r = parse({ artifactDir, home });
  assert.deepEqual(r.telemetry, { threadId: THREAD, turnId: null, resolvedModel: null, effort: null });
});

test("codex telemetry fails closed on a non-canonical completedAt", () => {
  const { artifactDir, home } = fixture();
  writeJob(artifactDir, "task-1", completedJob({ completedAt: "2026-10-13T08:00:00Z" }));
  writeRollout(home, [turnContext()]);
  assert.equal(parse({ artifactDir, home }).telemetry.turnId, null);
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

test("runWorkerSync passes artifactDir and the spawn env to parseOutput (telemetry lands on the job)", () => {
  isolateStateRoot();
  const repo = makeRepo();
  const home = tmp("ac-codex-home-");
  writeRollout(home, [turnContext()]);
  // Isolate HOME so instance aliases on this machine cannot relabel "codex".
  const saved = {
    HOME: process.env.HOME,
    AGENT_COLLAB_CODEX_HOME: process.env.AGENT_COLLAB_CODEX_HOME,
    AGENT_COLLAB_CODEX_COMPANION: process.env.AGENT_COLLAB_CODEX_COMPANION
  };
  process.env.HOME = tmp("ac-home-");
  process.env.AGENT_COLLAB_CODEX_HOME = home;
  const stubDir = tmp("ac-codexstub-");
  const stub = path.join(stubDir, "companion.mjs");
  // The stub writes its job record where the real companion does: under
  // CLAUDE_PLUGIN_DATA, which the adapter scopes to <artifactDir>/codex-companion.
  fs.writeFileSync(stub, `
    import fs from 'node:fs';
    import path from 'node:path';
    const jobs = path.join(process.env.CLAUDE_PLUGIN_DATA, 'state', 'ws-1234', 'jobs');
    fs.mkdirSync(jobs, { recursive: true });
    fs.writeFileSync(path.join(jobs, 'task-1.json'), JSON.stringify(${JSON.stringify(completedJob())}));
    process.stdout.write(${JSON.stringify(envelope())});
  `);
  process.env.AGENT_COLLAB_CODEX_COMPANION = stub;
  try {
    const res = runWorkerSync(repo, { driver: "claude", worker: "codex", role: "reviewer", brief: "review", maxAttempts: 1, noResume: true });
    assert.equal(res.status, "completed");
    assert.equal(res.resolvedModel, "gpt-5.6-luna");
    assert.equal(res.workerTelemetry?.effort, "medium");
    assert.equal(res.workerTelemetry?.turnId, TURN);
    const job = getJob(repo, res.jobId);
    assert.equal(job.resolvedModel, "gpt-5.6-luna");
    assert.equal(job.workerTelemetry?.effort, "medium");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
