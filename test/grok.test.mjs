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
  assert.ok(args.includes("--permission-mode") && args.includes("acceptEdits"));
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
