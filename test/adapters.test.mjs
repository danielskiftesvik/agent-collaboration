import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAdapter, listAdapters } from "../adapters/index.mjs";
import { pickLatestModel } from "../adapters/agy.mjs";

function stubBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bin-"));
  const file = path.join(dir, "stub.mjs");
  fs.writeFileSync(file, body);
  const sh = path.join(dir, "stub");
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${process.execPath} ${file} "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

test("registry exposes claude, agy and codex", () => {
  const names = listAdapters().map((a) => a.name).sort();
  assert.deepEqual(names, ["agy", "claude", "codex"]);
  assert.throws(() => getAdapter("nope"), /unknown adapter/i);
});

test("agy buildCommand runs headless, unattended, scoped to the workspace", () => {
  const agy = getAdapter("agy");
  const { args } = agy.buildCommand({
    role: "worker",
    brief: "do the thing",
    workspace: "/tmp/wt",
    timeoutMs: 300000
  });
  assert.ok(args.includes("-p"), "headless print mode");
  assert.ok(args.includes("--dangerously-skip-permissions"), "unattended");
  assert.ok(args.includes("--add-dir") && args.includes("/tmp/wt"), "workspace scoped");
  assert.ok(args.includes("--print-timeout"), "bounded");
  // Flag-ordering fix: -p must be LAST, immediately before the prompt. With -p
  // first, agy leaks later flags into the prompt and downgrades to Flash.
  assert.equal(args[args.length - 2], "-p", "-p immediately precedes the prompt");
  assert.equal(args[args.length - 1], "do the thing", "prompt is the final arg");
  assert.equal(agy.supportsStructuredOutput, false);
});

test("agy parseOutput returns stdout as the answer text", () => {
  const agy = getAdapter("agy");
  const r = agy.parseOutput({ stdout: "  the review\n", stderr: "", exitCode: 0 });
  assert.equal(r.answerText, "the review");
  assert.equal(r.structured, null);
});

test("claude buildCommand asks for JSON output; reviewer is read-only, worker can edit", () => {
  const claude = getAdapter("claude");
  const reviewer = claude.buildCommand({ role: "reviewer", brief: "review", workspace: "/w" });
  assert.ok(reviewer.args.includes("--output-format") && reviewer.args.includes("json"));
  assert.ok(reviewer.args.includes("--permission-mode") && reviewer.args.includes("plan"));

  const worker = claude.buildCommand({ role: "worker", brief: "build", workspace: "/w" });
  assert.ok(worker.args.includes("acceptEdits"));
});

test("claude parseOutput unwraps the result field from the JSON envelope", () => {
  const claude = getAdapter("claude");
  const envelope = JSON.stringify({ type: "result", subtype: "success", result: '{"status":"completed"}' });
  const r = claude.parseOutput({ stdout: envelope, stderr: "", exitCode: 0 });
  assert.equal(r.answerText, '{"status":"completed"}');
});

test("claude parseOutput falls back to raw stdout when not a JSON envelope", () => {
  const claude = getAdapter("claude");
  const r = claude.parseOutput({ stdout: "plain text answer", stderr: "", exitCode: 0 });
  assert.equal(r.answerText, "plain text answer");
});

test("pickLatestModel selects the newest in-class label, preferring High", () => {
  const models = [
    "Gemini 3.5 Flash (High)",
    "Gemini 3.1 Pro (Low)",
    "Gemini 3.1 Pro (High)",
    "Gemini 3.2 Pro (High)",
    "Claude Opus 4.6 (Thinking)"
  ];
  assert.equal(pickLatestModel(models, "Pro"), "Gemini 3.2 Pro (High)");
});

test("pickLatestModel returns null when the class is absent", () => {
  assert.equal(pickLatestModel(["Gemini 3.5 Flash (High)"], "Pro"), null);
});

test("agy pins the latest Pro label via --model, placed BEFORE -p", () => {
  delete process.env.AGENT_COLLAB_AGY_MODEL;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(
    `if (process.argv.includes('models')) process.stdout.write('Gemini 3.5 Flash (High)\\nGemini 3.1 Pro (High)\\nGemini 3.1 Pro (Low)')`
  );
  const { args } = getAdapter("agy").buildCommand({ role: "reviewer", brief: "x", workspace: "/w" });
  const mi = args.indexOf("--model");
  assert.ok(mi >= 0, "--model present");
  assert.equal(args[mi + 1], "Gemini 3.1 Pro (High)", "latest Pro (High) label");
  assert.ok(mi < args.indexOf("-p"), "--model comes before -p (agy parses flags before the positional)");
  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("agy buildCommand honors an explicit model env override", () => {
  process.env.AGENT_COLLAB_AGY_MODEL = "Gemini 3.5 Flash (High)";
  const r = getAdapter("agy").buildCommand({ role: "worker", brief: "x", workspace: "/w" });
  assert.ok(r.args.includes("--model") && r.args.includes("Gemini 3.5 Flash (High)"));
  delete process.env.AGENT_COLLAB_AGY_MODEL;
});

test("claude.outputContract gives a structured contract per role", () => {
  const claude = getAdapter("claude");
  assert.match(claude.outputContract("reviewer"), /verdict/);
  assert.match(claude.outputContract("worker"), /status/);
});

test("agy.outputContract is an example-anchored, JSON-only instruction", () => {
  const agy = getAdapter("agy");
  const c = agy.outputContract("reviewer");
  assert.match(c, /only.*json/i, "demands JSON only");
  assert.match(c, /nothing else|no prose|no text (before|outside)/i, "forbids surrounding prose");
  assert.match(c, /"verdict"/, "includes a concrete example");
});

test("codex.outputContract uses an XML structured-output block", () => {
  const codex = getAdapter("codex");
  const c = codex.outputContract("worker");
  assert.match(c, /<structured_output_contract>/);
});

test("codex parseOutput unwraps rawOutput from the companion envelope", () => {
  const codex = getAdapter("codex");
  const envelope = JSON.stringify({
    status: 0,
    threadId: "t",
    rawOutput: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
    touchedFiles: [],
    reasoningSummary: []
  });
  const r = codex.parseOutput({ stdout: envelope });
  assert.equal(r.answerText, '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}');
  assert.equal(r.structured, null);
});

test("probe reports availability and version from the binary", () => {
  const bin = stubBin('if (process.argv.includes("--version")) { console.log("1.0.12"); }');
  process.env.AGENT_COLLAB_AGY_BIN = bin;
  const r = getAdapter("agy").probe();
  assert.equal(r.available, true);
  assert.match(r.version, /1\.0\.12/);
  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("probe reports unavailable for a missing binary", () => {
  process.env.AGENT_COLLAB_AGY_BIN = "/nonexistent/agy-xyz";
  const r = getAdapter("agy").probe();
  assert.equal(r.available, false);
  delete process.env.AGENT_COLLAB_AGY_BIN;
});
