import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import opencode from "../adapters/opencode.mjs";

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
  delete process.env.AGENT_COLLAB_OPENCODE_BIN;
  delete process.env.AGENT_COLLAB_OPENCODE_MODEL;
  delete process.env.AGENT_COLLAB_OPENCODE_MODEL_REVIEW;
}

test("name and structured output support", () => {
  assert.equal(opencode.name, "opencode");
  assert.equal(opencode.supportsStructuredOutput, false);
});

test("background is false (no session-ID-based resume mechanism)", () => {
  assert.equal(opencode.background, false);
});

test("buildCommand runs headless, auto-approved, scoped to workspace, JSON NDJSON output", () => {
  clearEnv();
  const { args } = opencode.buildCommand({
    role: "worker",
    brief: "do the thing",
    workspace: "/tmp/wt"
  });
  assert.ok(args.includes("run"), "run subcommand");
  assert.ok(args.includes("--format") && args.includes("json"), "JSON NDJSON output");
  assert.ok(args.includes("--auto"), "auto-approve permissions");
  assert.ok(args.includes("--dir=/tmp/wt"), "workspace scoped via --dir= path");
  assert.equal(args[args.length - 1], "do the thing", "brief is the final arg");
});

test("buildCommand does NOT use --exclude-tools (opencode lacks that flag)", () => {
  clearEnv();
  const { args } = opencode.buildCommand({
    role: "worker",
    brief: "x",
    workspace: "/tmp/wt"
  });
  assert.ok(!args.includes("--exclude-tools"), "no --exclude-tools for worker");
  assert.ok(args.includes("--auto"), "safety via --auto + worktree isolation");
});

test("buildCommand reviewer does NOT get --auto (write tools are denied)", () => {
  clearEnv();
  const { args } = opencode.buildCommand({
    role: "reviewer",
    brief: "review",
    workspace: "/tmp/wt"
  });
  assert.ok(!args.includes("--exclude-tools"), "no --exclude-tools for reviewer");
  assert.ok(!args.includes("--auto"), "reviewer has no --auto — write tools denied headlessly");
});

test("buildCommand omits --model when no env or pin is set", () => {
  clearEnv();
  const { args } = opencode.buildCommand({ role: "worker", brief: "x" });
  assert.ok(!args.includes("--model"), "no --model without env");
});

test("buildCommand honors AGENT_COLLAB_OPENCODE_MODEL", () => {
  clearEnv();
  process.env.AGENT_COLLAB_OPENCODE_MODEL = "anthropic/claude-sonnet-4-20250514";
  const { args } = opencode.buildCommand({ role: "worker", brief: "x" });
  const mi = args.indexOf("--model");
  assert.ok(mi >= 0);
  assert.equal(args[mi + 1], "anthropic/claude-sonnet-4-20250514");
  clearEnv();
});

test("AGENT_COLLAB_OPENCODE_MODEL_REVIEW applies to reviewers only", () => {
  clearEnv();
  process.env.AGENT_COLLAB_OPENCODE_MODEL_REVIEW = "openai/gpt-5.6-terra";
  const reviewer = opencode.buildCommand({ role: "reviewer", brief: "x" });
  assert.equal(reviewer.args[reviewer.args.indexOf("--model") + 1], "openai/gpt-5.6-terra");
  const worker = opencode.buildCommand({ role: "worker", brief: "x" });
  assert.ok(!worker.args.includes("--model"), "role-scoped var must not leak to workers");
  clearEnv();
});

test("generic MODEL env overrides the per-role MODEL_REVIEW", () => {
  clearEnv();
  process.env.AGENT_COLLAB_OPENCODE_MODEL_REVIEW = "openai/gpt-5.6-terra";
  process.env.AGENT_COLLAB_OPENCODE_MODEL = "anthropic/claude-sonnet-4-20250514";
  const reviewer = opencode.buildCommand({ role: "reviewer", brief: "x" });
  assert.equal(reviewer.args[reviewer.args.indexOf("--model") + 1], "anthropic/claude-sonnet-4-20250514");
  clearEnv();
});

test("parseOutput extracts text from a single-step NDJSON stream", () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"s1","part":{"id":"p2","type":"text","text":"Hello"}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"id":"p3","reason":"stop","tokens":{"input":100,"output":5,"total":105},"cost":0.01}}',
  ].join("\n");
  const r = opencode.parseOutput({ stdout: ndjson });
  assert.equal(r.answerText, "Hello");
  assert.equal(r.structured, null);
  assert.equal(r.telemetry.sessionId, "s1");
  assert.equal(r.telemetry.inputTokens, 100);
  assert.equal(r.telemetry.outputTokens, 5);
  assert.equal(r.telemetry.totalTokens, 105);
  assert.equal(r.telemetry.costUsd, 0.01);
});

test("parseOutput accepts text from non-stop terminal reasons (e.g. length)", () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"s1","part":{"id":"p2","type":"text","text":"Partial output"}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"id":"p3","reason":"length","tokens":{"input":100,"output":50,"total":150}}}',
  ].join("\n");
  const r = opencode.parseOutput({ stdout: ndjson });
  assert.equal(r.answerText, "Partial output");
  assert.equal(r.structured, null);
  assert.equal(r.truncated, true);
});

test("parseOutput skips tool-calling steps, accepts only the final terminal step", () => {
  const ndjson = [
    // Step 1: tool-using step (intermediate — no text)
    '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","type":"step-start"}}',
    '{"type":"tool_use","timestamp":2,"sessionID":"s1","part":{"type":"tool","tool":"edit","state":{"status":"completed"}}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"id":"p3","reason":"tool-calls","tokens":{"input":200,"output":50,"total":250}}}',
    // Step 2: final response step
    '{"type":"step_start","timestamp":4,"sessionID":"s1","part":{"id":"p4","type":"step-start"}}',
    '{"type":"text","timestamp":5,"sessionID":"s1","part":{"id":"p5","type":"text","text":"Done."}}',
    '{"type":"step_finish","timestamp":6,"sessionID":"s1","part":{"id":"p6","reason":"stop","tokens":{"input":300,"output":10,"total":310},"cost":0.02}}',
  ].join("\n");
  const r = opencode.parseOutput({ stdout: ndjson });
  assert.equal(r.answerText, "Done.");
  assert.equal(r.telemetry.inputTokens, 300);
  assert.equal(r.telemetry.outputTokens, 10);
  assert.equal(r.telemetry.costUsd, 0.02);
});

test("parseOutput returns error when an error event is present (no text)", () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","type":"step-start"}}',
    '{"type":"error","timestamp":2,"sessionID":"s1","error":{"name":"UnknownError","data":{"message":"API key not configured"}}}',
  ].join("\n");
  const r = opencode.parseOutput({ stdout: ndjson });
  assert.equal(r.answerText, "");
  assert.equal(r.error, "API key not configured");
});

test("parseOutput returns error even when answer text exists from a prior terminal step", () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"s1","part":{"id":"p2","type":"text","text":"Some text "}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"id":"p3","reason":"stop","tokens":{"input":50,"output":10,"total":60}}}',
    '{"type":"error","timestamp":4,"sessionID":"s1","error":{"message":"API error after completion"}}',
  ].join("\n");
  const r = opencode.parseOutput({ stdout: ndjson });
  assert.equal(r.answerText, "Some text ");
  assert.equal(r.error, "API error after completion");
});

test("parseOutput returns error from a plain error.message format", () => {
  const ndjson = [
    '{"type":"error","timestamp":1,"sessionID":"s1","error":{"message":"network error"}}',
  ].join("\n");
  const r = opencode.parseOutput({ stdout: ndjson });
  assert.equal(r.error, "network error");
});

test("parseOutput falls back to raw trimmed text when there are no JSON events", () => {
  const r = opencode.parseOutput({ stdout: "  plain text answer  " });
  assert.equal(r.answerText, "plain text answer");
});

test("parseOutput handles empty stdout gracefully", () => {
  const r = opencode.parseOutput({ stdout: "" });
  assert.equal(r.answerText, "");
});

test("parseOutput handles malformed NDJSON lines gracefully", () => {
  const ndjson = [
    'not json at all',
    '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","type":"step-start"}}',
    '{"type":"text","timestamp":2,"sessionID":"s1","part":{"id":"p2","type":"text","text":"Works"}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"id":"p3","reason":"stop"}}',
  ].join("\n");
  const r = opencode.parseOutput({ stdout: ndjson });
  assert.equal(r.answerText, "Works");
});

test("parseOutput aggregates telemetry across steps, using only the final step's values", () => {
  const ndjson = [
    '{"type":"step_start","timestamp":1,"sessionID":"s1","part":{"id":"p1","type":"step-start"}}',
    '{"type":"tool_use","timestamp":2,"sessionID":"s1","part":{"type":"tool"}}',
    '{"type":"step_finish","timestamp":3,"sessionID":"s1","part":{"id":"p3","reason":"tool-calls","tokens":{"input":100,"output":20,"total":120}}}',
    '{"type":"step_start","timestamp":4,"sessionID":"s1","part":{"id":"p4","type":"step-start"}}',
    '{"type":"text","timestamp":5,"sessionID":"s1","part":{"id":"p5","type":"text","text":"Result"}}',
    '{"type":"step_finish","timestamp":6,"sessionID":"s1","part":{"id":"p6","reason":"stop","tokens":{"input":150,"output":5,"total":155,"cache":{"write":0,"read":100}},"cost":0.015}}',
  ].join("\n");
  const r = opencode.parseOutput({ stdout: ndjson });
  assert.equal(r.answerText, "Result");
  assert.equal(r.telemetry.inputTokens, 150);
  assert.equal(r.telemetry.outputTokens, 5);
  assert.equal(r.telemetry.totalTokens, 155);
  assert.equal(r.telemetry.cacheWrite, 0);
  assert.equal(r.telemetry.cacheRead, 100);
  assert.equal(r.telemetry.costUsd, 0.015);
  assert.equal(r.telemetry.sessionId, "s1");
});

test("outputContract gives a structured contract per role", () => {
  const reviewer = opencode.outputContract("reviewer");
  assert.match(reviewer, /verdict/);
  assert.match(reviewer, /Every actionable defect must be in findings/);
  assert.match(reviewer, /needs-attention verdict requires at least one finding/);
  assert.match(reviewer, /"approve"/);

  const worker = opencode.outputContract("worker");
  assert.match(worker, /status/);
  assert.match(worker, /"completed"/);
  assert.match(worker, /"failed"/);
  assert.match(worker, /"blocked"/);
});

test("probe reports available when the binary responds", () => {
  clearEnv();
  const bin = stubBin('if (process.argv.includes("--version")) { console.log("1.18.4"); }');
  process.env.AGENT_COLLAB_OPENCODE_BIN = bin;
  const r = opencode.probe();
  assert.equal(r.available, true);
  assert.match(r.version, /1\.18\.4/);
  clearEnv();
});

test("probe reports unavailable for a missing binary", () => {
  clearEnv();
  process.env.AGENT_COLLAB_OPENCODE_BIN = "/nonexistent/opencode-xyz";
  const r = opencode.probe();
  assert.equal(r.available, false);
  assert.ok(r.error && r.error.length > 0);
  clearEnv();
});
