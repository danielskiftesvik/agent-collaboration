import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getAdapter, listAdapters } from "../adapters/index.mjs";
import { pickLatestModel } from "../adapters/agy.mjs";
import qwen from "../adapters/qwen.mjs";

function stubBin(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-bin-"));
  const file = path.join(dir, "stub.mjs");
  fs.writeFileSync(file, body);
  const sh = path.join(dir, "stub");
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${process.execPath} ${file} "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

test("registry exposes claude, agy, codex and qwen", () => {
  const names = listAdapters().map((a) => a.name).sort();
  assert.deepEqual(names, ["agy", "claude", "codex", "qwen"]);
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

test("agy parseOutput removes its workspace log before patch capture", () => {
  const agy = getAdapter("agy");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ac-agy-wt-"));
  const logFile = path.join(workspace, "agy-worker.jsonl");
  fs.writeFileSync(logFile, "log noise\n");

  agy.parseOutput({ stdout: "{}", stderr: "", exitCode: 0, workspace });

  assert.equal(fs.existsSync(logFile), false);
});

test("claude buildCommand STREAMS output (heartbeat); reviewer is read-only, worker can edit", () => {
  const claude = getAdapter("claude");
  const reviewer = claude.buildCommand({ role: "reviewer", brief: "review", workspace: "/w" });
  // stream-json (+ --verbose) so a long run emits a continuous stdout heartbeat the
  // idle watchdog can see — not a single blob at the end.
  assert.ok(reviewer.args.includes("--output-format") && reviewer.args.includes("stream-json"));
  assert.ok(reviewer.args.includes("--verbose"));
  assert.ok(reviewer.args.includes("--permission-mode") && reviewer.args.includes("plan"));

  const worker = claude.buildCommand({ role: "worker", brief: "build", workspace: "/w" });
  assert.ok(worker.args.includes("acceptEdits"));
});

test("claude buildCommand pins the default model by default", () => {
  delete process.env.AGENT_COLLAB_CLAUDE_MODEL;
  const { args } = getAdapter("claude").buildCommand({ role: "reviewer", brief: "x", workspace: "/w" });
  const mi = args.indexOf("--model");
  assert.ok(mi >= 0, "--model present");
  assert.equal(args[mi + 1], "default");
});

test("claude buildCommand honors an explicit model env override", () => {
  process.env.AGENT_COLLAB_CLAUDE_MODEL = "opus";
  const { args } = getAdapter("claude").buildCommand({ role: "worker", brief: "x", workspace: "/w" });
  const mi = args.indexOf("--model");
  assert.equal(args[mi + 1], "opus");
  delete process.env.AGENT_COLLAB_CLAUDE_MODEL;
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

const MODELS_STUB =
  `if (process.argv.includes('models')) process.stdout.write('Gemini 3.5 Flash (High)\\nGemini 3.1 Pro (High)\\nGemini 3.1 Pro (Low)')`;

test("agy pins the latest Flash label by default (speed), placed BEFORE -p", () => {
  delete process.env.AGENT_COLLAB_AGY_MODEL;
  delete process.env.AGENT_COLLAB_AGY_CLASS;
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(MODELS_STUB);
  const { args } = getAdapter("agy").buildCommand({ role: "reviewer", brief: "x", workspace: "/w" });
  const mi = args.indexOf("--model");
  assert.ok(mi >= 0, "--model present");
  assert.equal(args[mi + 1], "Gemini 3.5 Flash (High)", "default = latest Flash (High) label");
  assert.ok(mi < args.indexOf("-p"), "--model comes before -p (agy parses flags before the positional)");
  delete process.env.AGENT_COLLAB_AGY_BIN;
});

test("AGENT_COLLAB_AGY_CLASS=Pro pins the latest Pro label", () => {
  delete process.env.AGENT_COLLAB_AGY_MODEL;
  process.env.AGENT_COLLAB_AGY_CLASS = "Pro";
  process.env.AGENT_COLLAB_AGY_BIN = stubBin(MODELS_STUB);
  const { args } = getAdapter("agy").buildCommand({ role: "reviewer", brief: "x", workspace: "/w" });
  const mi = args.indexOf("--model");
  assert.equal(args[mi + 1], "Gemini 3.1 Pro (High)");
  delete process.env.AGENT_COLLAB_AGY_BIN;
  delete process.env.AGENT_COLLAB_AGY_CLASS;
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

test("qwen buildCommand runs headless, unattended, bare, pinned to the local endpoint", () => {
  const { args } = qwen.buildCommand({
    role: "worker",
    brief: "do the thing",
    workspace: "/tmp/wt",
    timeoutMs: 300000
  });
  assert.ok(args.includes("--bare"), "bare mode (cuts ~19-30K token startup overhead)");
  assert.ok(args.includes("--approval-mode") && args.includes("yolo"), "unattended");
  assert.ok(args.includes("--add-dir") && args.includes("/tmp/wt"), "workspace scoped");
  assert.ok(args.includes("--openai-base-url") && args.includes("http://127.0.0.1:1234/v1"), "pinned local endpoint");
  assert.ok(args.includes("--auth-type") && args.includes("openai"), "auth type pinned, not inherited");
  assert.ok(args.includes("--max-wall-time"), "bounded");
  assert.ok(args.includes("--exclude-tools") && args.includes("web_fetch"), "network-capable tool excluded");
  assert.ok(args.includes("--allowed-tools"), "explicit allow-list — yolo mode alone declined a tool call in the pilot");
  assert.ok(args.includes("--output-format") && args.includes("json"), "buffered json, NOT stream-json — see Step 0");
  assert.ok(!args.includes("stream-json"), "must not use stream-json — piloted and rejected (0/3 completions)");
  assert.ok(!args.includes("-m"), "no -m flag unless AGENT_COLLAB_QWEN_MODEL is set — inherit qwen's own configured default");
});

test("qwen buildCommand respects AGENT_COLLAB_QWEN_MODEL and a loopback AGENT_COLLAB_QWEN_BASE_URL override", () => {
  process.env.AGENT_COLLAB_QWEN_MODEL = "some-local-model";
  process.env.AGENT_COLLAB_QWEN_BASE_URL = "http://127.0.0.1:9999/v1";
  const { args } = qwen.buildCommand({ role: "worker", brief: "x", workspace: "/tmp/wt", timeoutMs: 60000 });
  assert.ok(args.includes("-m") && args.includes("some-local-model"));
  assert.ok(args.includes("http://127.0.0.1:9999/v1"));
  delete process.env.AGENT_COLLAB_QWEN_MODEL;
  delete process.env.AGENT_COLLAB_QWEN_BASE_URL;
});

test("qwen buildCommand refuses a non-loopback AGENT_COLLAB_QWEN_BASE_URL", () => {
  process.env.AGENT_COLLAB_QWEN_BASE_URL = "https://evil.example.com/v1";
  const { command, args } = qwen.buildCommand({ role: "worker", brief: "x", workspace: "/tmp/wt", timeoutMs: 60000 });
  assert.equal(command, process.execPath, "refuses by building a command that fails fast, not by running qwen for real");
  assert.ok(args.some((a) => typeof a === "string" && a.includes("refusing non-loopback")));
  delete process.env.AGENT_COLLAB_QWEN_BASE_URL;
});

test("AGENT_COLLAB_QWEN_ALLOW_REMOTE=on explicitly permits a non-loopback endpoint", () => {
  process.env.AGENT_COLLAB_QWEN_BASE_URL = "https://example.com/v1";
  process.env.AGENT_COLLAB_QWEN_ALLOW_REMOTE = "on";
  const { args } = qwen.buildCommand({ role: "worker", brief: "x", workspace: "/tmp/wt", timeoutMs: 60000 });
  assert.ok(args.includes("https://example.com/v1"));
  delete process.env.AGENT_COLLAB_QWEN_BASE_URL;
  delete process.env.AGENT_COLLAB_QWEN_ALLOW_REMOTE;
});

test("qwen probe refuses a non-loopback AGENT_COLLAB_QWEN_BASE_URL without ever hitting the network", () => {
  process.env.AGENT_COLLAB_QWEN_BIN = stubBin(`process.stdout.write('qwen 0.19.3');`);
  process.env.AGENT_COLLAB_QWEN_BASE_URL = "https://evil.example.com/v1";
  const r = qwen.probe();
  assert.equal(r.available, false);
  assert.match(r.error, /non-loopback/i);
  delete process.env.AGENT_COLLAB_QWEN_BIN;
  delete process.env.AGENT_COLLAB_QWEN_BASE_URL;
});

test("qwen parseOutput extracts the terminal result event from the buffered JSON array", () => {
  const stdout = JSON.stringify([
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "text", text: "working..." }] } },
    { type: "result", subtype: "success", result: '{"status":"completed","summary":"did it","changed":false}' }
  ]);
  const { answerText } = qwen.parseOutput({ stdout });
  assert.equal(answerText, '{"status":"completed","summary":"did it","changed":false}');
});

test("qwen parseOutput falls back to raw trimmed text when the array has no result event", () => {
  const stdout = JSON.stringify([{ type: "system", subtype: "init" }]);
  const { answerText } = qwen.parseOutput({ stdout });
  assert.equal(answerText, stdout.trim());
});

test("qwen parseOutput falls back to raw trimmed text when stdout isn't valid JSON at all", () => {
  const { answerText } = qwen.parseOutput({ stdout: "  plain text, no JSON array  " });
  assert.equal(answerText, "plain text, no JSON array");
});

test("qwen probe reports unavailable with a clear message when the binary is missing", () => {
  process.env.AGENT_COLLAB_QWEN_BIN = "/nonexistent/qwen-binary-xyz";
  const r = qwen.probe();
  assert.equal(r.available, false);
  assert.ok(r.error && r.error.length > 0);
  delete process.env.AGENT_COLLAB_QWEN_BIN;
});

test("qwen probe reports unavailable with a clear message when the local server is unreachable", () => {
  process.env.AGENT_COLLAB_QWEN_BIN = stubBin(`process.stdout.write('qwen 0.19.3');`);
  process.env.AGENT_COLLAB_QWEN_BASE_URL = "http://127.0.0.1:1/v1"; // closed port, fails fast
  const r = qwen.probe();
  assert.equal(r.available, false);
  assert.match(r.error, /unreachable|LM Studio/i);
  delete process.env.AGENT_COLLAB_QWEN_BIN;
  delete process.env.AGENT_COLLAB_QWEN_BASE_URL;
});

// No "probe reports available against a live local server" unit test: qwen.probe()
// shells out to curl via the codebase's synchronous, blocking run()/spawnSync — an
// in-process http.createServer sharing that same single-threaded test process
// deadlocks (the event loop can't service the incoming connection while frozen
// waiting on the very curl subprocess that's waiting for that connection).
// Reproduced directly while implementing this plan. A real, separate child process
// could avoid it, but adds real timing/port-coordination complexity for one
// assertion; the positive path is exercised implicitly by every live qwen run
// throughout this project's development instead.

