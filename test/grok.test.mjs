import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import grok from "../adapters/grok.mjs";

function stubBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bin-"));
  const file = path.join(dir, "stub.mjs");
  fs.writeFileSync(file, body);
  const sh = path.join(dir, "stub");
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${process.execPath} ${file} "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

function clearEnv() {
  delete process.env.AGENT_COLLAB_GROK_BIN;
  delete process.env.AGENT_COLLAB_GROK_MODEL;
  delete process.env.AGENT_COLLAB_GROK_MODEL_REVIEW;
  delete process.env.AGENT_COLLAB_GROK_EFFORT;
  delete process.env.AGENT_COLLAB_GROK_EFFORT_REVIEW;
}

test("name and structured output support", () => {
  assert.equal(grok.name, "grok");
  assert.equal(grok.supportsStructuredOutput, false);
});

test("buildCommand runs headless Grok Build with streaming-json and workspace cwd", () => {
  clearEnv();
  const { command, args } = grok.buildCommand({
    role: "worker",
    brief: "do the thing",
    workspace: "/tmp/wt"
  });
  assert.equal(command, "grok");
  assert.ok(args.includes("--single"), "headless single-turn");
  assert.ok(args.includes("do the thing"));
  assert.ok(args.includes("--output-format") && args.includes("streaming-json"));
  assert.ok(args.includes("--model") && args.includes("grok-4.5"));
  assert.ok(args.includes("--permission-mode") && args.includes("bypassPermissions"));
  assert.ok(args.includes("--cwd") && args.includes("/tmp/wt"));
});

test("buildCommand reviewer is read-only via permission-mode plan", () => {
  clearEnv();
  const { args } = grok.buildCommand({
    role: "reviewer",
    brief: "review",
    workspace: "/tmp/wt"
  });
  const pi = args.indexOf("--permission-mode");
  assert.ok(pi >= 0);
  assert.equal(args[pi + 1], "plan");
});

test("buildCommand honors AGENT_COLLAB_GROK_MODEL", () => {
  clearEnv();
  process.env.AGENT_COLLAB_GROK_MODEL = "grok-build";
  const { args } = grok.buildCommand({ role: "worker", brief: "x" });
  assert.equal(args[args.indexOf("--model") + 1], "grok-build");
  clearEnv();
});

test("AGENT_COLLAB_GROK_MODEL_REVIEW applies to reviewers only", () => {
  clearEnv();
  process.env.AGENT_COLLAB_GROK_MODEL_REVIEW = "grok-build";
  const reviewer = grok.buildCommand({ role: "reviewer", brief: "x" });
  assert.equal(reviewer.args[reviewer.args.indexOf("--model") + 1], "grok-build");
  const worker = grok.buildCommand({ role: "worker", brief: "x" });
  assert.equal(worker.args[worker.args.indexOf("--model") + 1], "grok-4.5");
  clearEnv();
});

test("generic MODEL env overrides the per-role MODEL_REVIEW", () => {
  clearEnv();
  process.env.AGENT_COLLAB_GROK_MODEL_REVIEW = "grok-build";
  process.env.AGENT_COLLAB_GROK_MODEL = "grok-4.5";
  const reviewer = grok.buildCommand({ role: "reviewer", brief: "x" });
  assert.equal(reviewer.args[reviewer.args.indexOf("--model") + 1], "grok-4.5");
  clearEnv();
});

test("buildCommand honors AGENT_COLLAB_GROK_EFFORT", () => {
  clearEnv();
  process.env.AGENT_COLLAB_GROK_EFFORT = "high";
  const { args } = grok.buildCommand({ role: "worker", brief: "x" });
  assert.ok(args.includes("--effort"));
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  clearEnv();
});

test("parseOutput accumulates streaming-json text events and end telemetry", () => {
  const stdout = [
    '{"type":"thought","data":"thinking"}',
    '{"type":"text","data":"Hello"}',
    '{"type":"text","data":" world"}',
    '{"type":"end","stopReason":"EndTurn","sessionId":"s1","requestId":"r1","num_turns":2,"usage":{"total_tokens":10},"modelUsage":{"grok-4.5-build":{"modelCalls":1}}}'
  ].join("\n");
  const out = grok.parseOutput({ stdout });
  assert.equal(out.answerText, "Hello world");
  assert.equal(out.error, null);
  assert.equal(out.telemetry.sessionId, "s1");
  assert.equal(out.telemetry.requestId, "r1");
  assert.deepEqual(out.telemetry.resolvedModels, ["grok-4.5-build"]);
});

test("worker runs with bypassPermissions so shell tools (build/test) can execute", () => {
  // Measured 2026-07-25 against grok-4.5: every other permission mode cancels
  // on the FIRST shell tool call in a headless run (no TTY to approve it).
  //   default | acceptEdits | auto | dontAsk -> stopReason=Cancelled, turn 1, nothing ran
  //   bypassPermissions                      -> stopReason=EndTurn, command executed
  // acceptEdits let grok edit files but never build or test, so it could not
  // verify its own work and the run died at the verification step.
  const { args } = grok.buildCommand({ role: "worker", brief: "x" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
});

test("reviewer stays read-only in plan mode", () => {
  const { args } = grok.buildCommand({ role: "reviewer", brief: "x" });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
});

test("parseOutput keeps only the final segment's text, not narration from earlier turns", () => {
  // Grok emits interim narration as `text` events and closes each agentic
  // segment with an `end`. Accumulating across segments produced run-on
  // progress notes instead of the answer (observed 2026-07-25: 190 text
  // events across 2 segments concatenated into one report).
  const stdout = [
    '{"type":"text","data":"Reading the files first."}',
    '{"type":"end","stopReason":"EndTurn","sessionId":"s1","num_turns":4}',
    '{"type":"text","data":"Final answer."}',
    '{"type":"end","stopReason":"EndTurn","sessionId":"s1","num_turns":2}'
  ].join("\n");
  const out = grok.parseOutput({ stdout });
  assert.equal(out.answerText, "Final answer.");
});

test("parseOutput flags a cancelled run so a partial worker patch is not read as complete", () => {
  // grok exits 0 even when its own stopReason is Cancelled, and for workers
  // dispatch derives success from `changed && patchApplies` — so a half-finished
  // run whose partial patch happens to apply reads as success. Surface it.
  const stdout = [
    '{"type":"text","data":"Applying the edits"}',
    '{"type":"end","stopReason":"Cancelled","sessionId":"s1","num_turns":11}'
  ].join("\n");
  const out = grok.parseOutput({ stdout });
  assert.equal(out.incomplete, true);
  assert.equal(out.telemetry.stopReason, "Cancelled");
  assert.match(out.answerText, /INCOMPLETE/);
  assert.match(out.answerText, /Cancelled/);
  assert.match(out.answerText, /Applying the edits/);
});

test("parseOutput does not flag a normal EndTurn run as incomplete", () => {
  const stdout = [
    '{"type":"text","data":"All done."}',
    '{"type":"end","stopReason":"EndTurn","sessionId":"s1","num_turns":3}'
  ].join("\n");
  const out = grok.parseOutput({ stdout });
  assert.notEqual(out.incomplete, true);
  assert.equal(out.answerText, "All done.");
  assert.equal(out.telemetry.stopReason, "EndTurn");
  assert.equal(out.telemetry.stopReasonNormalized, "endturn");
});

test("parseOutput does not flag snake_case end_turn as incomplete (current Grok CLI)", () => {
  // Observed 2026-08-13: CLI reports clean termination as "end_turn"; the old
  // strict === "EndTurn" check false-positived every successful run.
  const stdout = [
    '{"type":"text","data":"Review complete."}',
    '{"type":"end","stopReason":"end_turn","sessionId":"s1","num_turns":5}'
  ].join("\n");
  const out = grok.parseOutput({ stdout });
  assert.notEqual(out.incomplete, true);
  assert.equal(out.answerText, "Review complete.");
  assert.equal(out.telemetry.stopReason, "end_turn");
  assert.equal(out.telemetry.stopReasonNormalized, "endturn");
  assert.doesNotMatch(out.answerText, /INCOMPLETE/);
});

test("normalizeStopReason treats EndTurn / end_turn / end-turn as the same success token", async () => {
  const { normalizeStopReason, isIncompleteStopReason } = await import("../adapters/grok.mjs");
  assert.equal(normalizeStopReason("EndTurn"), "endturn");
  assert.equal(normalizeStopReason("end_turn"), "endturn");
  assert.equal(normalizeStopReason("end-turn"), "endturn");
  assert.equal(isIncompleteStopReason("EndTurn"), false);
  assert.equal(isIncompleteStopReason("end_turn"), false);
  assert.equal(isIncompleteStopReason("Cancelled"), true);
  assert.equal(isIncompleteStopReason("cancelled"), true);
  assert.equal(isIncompleteStopReason(null), false);
});

test("parseOutput returns error from streaming-json error events", () => {
  const stdout =
    '{"type":"error","message":"You\\u2019ve reached your free Grok Build usage limit for now."}';
  const out = grok.parseOutput({ stdout });
  assert.match(out.error, /Grok Build usage limit/i);
});

test("parseOutput falls back to plain json envelope with .text", () => {
  const stdout = JSON.stringify({
    text: "done",
    stopReason: "EndTurn",
    sessionId: "abc",
    usage: { total_tokens: 3 }
  });
  const out = grok.parseOutput({ stdout });
  assert.equal(out.answerText, "done");
  assert.equal(out.telemetry.sessionId, "abc");
});

test("parseOutput falls back to raw trimmed text when there are no JSON events", () => {
  const out = grok.parseOutput({ stdout: "  plain prose  " });
  assert.equal(out.answerText, "plain prose");
});

test("outputContract gives a structured contract per role", () => {
  assert.match(grok.outputContract("reviewer"), /verdict/);
  assert.match(grok.outputContract("worker"), /changed/);
});

test("progressDirs watches ~/.grok sessions and logs", () => {
  const dirs = grok.progressDirs();
  assert.ok(dirs.some((d) => d.endsWith(path.join(".grok", "sessions"))));
  assert.ok(dirs.some((d) => d.endsWith(path.join(".grok", "logs"))));
});

test("probe reports available when the binary responds", () => {
  const stub = stubBin("process.stdout.write('grok 0.2.112 (test) [stable]\\n');");
  process.env.AGENT_COLLAB_GROK_BIN = stub;
  try {
    const p = grok.probe();
    assert.equal(p.available, true);
    assert.match(p.version, /0\.2\.112/);
  } finally {
    clearEnv();
  }
});

test("probe reports unavailable for a missing binary", () => {
  process.env.AGENT_COLLAB_GROK_BIN = "/no/such/grok-binary";
  try {
    const p = grok.probe();
    assert.equal(p.available, false);
    assert.ok(p.error);
  } finally {
    clearEnv();
  }
});
