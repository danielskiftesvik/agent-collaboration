import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAdapter, listAdapters } from "../adapters/index.mjs";

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
  assert.equal(args[args.length - 1], "do the thing", "prompt is the trailing positional");
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
