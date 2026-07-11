import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePin, _clearPinCache, PIN_FILE } from "../core/pins.mjs";
import { getAdapter } from "../adapters/index.mjs";

function repoWith(pins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-pins-"));
  fs.writeFileSync(path.join(dir, PIN_FILE), JSON.stringify(pins));
  return dir;
}

function clearEnv() {
  for (const k of [
    "AGENT_COLLAB_CODEX_MODEL",
    "AGENT_COLLAB_CODEX_MODEL_REVIEW",
    "AGENT_COLLAB_CODEX_EFFORT",
    "AGENT_COLLAB_CODEX_EFFORT_REVIEW",
    "AGENT_COLLAB_CLAUDE_MODEL",
    "AGENT_COLLAB_AGY_MODEL",
    "AGENT_COLLAB_AGY_CLASS"
  ]) {
    delete process.env[k];
  }
}

test("resolvePin reads a role pin from the workspace's .agent-collab.json", () => {
  _clearPinCache();
  const dir = repoWith({
    workers: { codex: { reviewer: { model: "gpt-5.6-terra", effort: "high" } } }
  });
  const pin = resolvePin("codex", "reviewer", dir);
  assert.equal(pin.model, "gpt-5.6-terra");
  assert.equal(pin.effort, "high");
  // Role isolation: a reviewer pin never leaks to the worker role.
  const worker = resolvePin("codex", "worker", dir);
  assert.equal(worker.model, null);
});

test("resolvePin walks up from a subdirectory to the repo root", () => {
  _clearPinCache();
  const dir = repoWith({ workers: { claude: { worker: { model: "sonnet" } } } });
  const sub = path.join(dir, "a/b/c");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(resolvePin("claude", "worker", sub).model, "sonnet");
});

test("resolvePin returns nulls for a missing file and survives malformed JSON", () => {
  _clearPinCache();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ac-pins-empty-"));
  assert.deepEqual(resolvePin("codex", "reviewer", empty), { model: null, effort: null });
  _clearPinCache();
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "ac-pins-bad-"));
  fs.writeFileSync(path.join(bad, PIN_FILE), "{not json");
  assert.deepEqual(resolvePin("codex", "reviewer", bad), { model: null, effort: null });
});

test("codex buildCommand uses the repo pin when env is unset; env still wins", () => {
  _clearPinCache();
  clearEnv();
  process.env.AGENT_COLLAB_CODEX_COMPANION = "/stub/codex-companion.mjs";
  const dir = repoWith({
    workers: { codex: { reviewer: { model: "gpt-5.6-terra", effort: "high" } } }
  });
  const pinned = getAdapter("codex").buildCommand({ role: "reviewer", brief: "x", workspace: dir });
  assert.equal(pinned.args[pinned.args.indexOf("--model") + 1], "gpt-5.6-terra");
  assert.equal(pinned.args[pinned.args.indexOf("--effort") + 1], "high");
  // Per-dispatch escalation beats the standing pin:
  process.env.AGENT_COLLAB_CODEX_MODEL = "gpt-5.6-sol";
  const escalated = getAdapter("codex").buildCommand({ role: "reviewer", brief: "x", workspace: dir });
  assert.equal(escalated.args[escalated.args.indexOf("--model") + 1], "gpt-5.6-sol");
  assert.equal(escalated.args[escalated.args.indexOf("--effort") + 1], "high");
  clearEnv();
  delete process.env.AGENT_COLLAB_CODEX_COMPANION;
});

test("claude buildCommand prefers repo pin over 'default'; env beats pin", () => {
  _clearPinCache();
  clearEnv();
  const dir = repoWith({ workers: { claude: { worker: { model: "sonnet" } } } });
  const pinned = getAdapter("claude").buildCommand({ role: "worker", brief: "x", workspace: dir });
  assert.equal(pinned.args[pinned.args.indexOf("--model") + 1], "sonnet");
  process.env.AGENT_COLLAB_CLAUDE_MODEL = "opus";
  const env = getAdapter("claude").buildCommand({ role: "worker", brief: "x", workspace: dir });
  assert.equal(env.args[env.args.indexOf("--model") + 1], "opus");
  clearEnv();
});

test("agy buildCommand uses the repo pin label when env levers are unset", () => {
  _clearPinCache();
  clearEnv();
  const dir = repoWith({
    workers: { agy: { reviewer: { model: "Gemini 3.1 Pro (Low)" } } }
  });
  const { args } = getAdapter("agy").buildCommand({
    role: "reviewer",
    brief: "x",
    workspace: dir,
    timeoutMs: 60000
  });
  assert.equal(args[args.indexOf("--model") + 1], "Gemini 3.1 Pro (Low)");
  clearEnv();
});
