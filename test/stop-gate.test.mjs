import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeRepo, isolateStateRoot } from "./helpers.mjs";
import { run } from "../core/process.mjs";
import { loadState } from "../core/state.mjs";
import { decideStop } from "../core/stop-gate.mjs";

const CLI = fileURLToPath(new URL("../scripts/agent-companion.mjs", import.meta.url));

test("decideStop blocks when the gate is on and not re-entrant", () => {
  const d = decideStop({ stopHookActive: false, config: { stopReviewGate: true } });
  assert.equal(d.block, true);
  assert.match(d.reason, /review/i);
});

test("decideStop allows when stop_hook_active (reentrancy guard)", () => {
  const d = decideStop({ stopHookActive: true, config: { stopReviewGate: true } });
  assert.equal(d.block, false);
});

test("decideStop allows when the gate is off", () => {
  const d = decideStop({ stopHookActive: false, config: { stopReviewGate: false } });
  assert.equal(d.block, false);
});

test("sandbox is opt-in: off by default, on after setup --sandbox on", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const env = { ...process.env, AGENT_COLLAB_DATA: dataDir };
  assert.notEqual(loadState(repo).config.sandbox, true, "off by default");
  const r = run(process.execPath, [CLI, "setup", "--sandbox", "on"], { cwd: repo, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadState(repo).config.sandbox, true);
});

test("setup --gate on persists the config flag", () => {
  const dataDir = isolateStateRoot();
  const repo = makeRepo();
  const env = { ...process.env, AGENT_COLLAB_DATA: dataDir };
  const r = run(process.execPath, [CLI, "setup", "--gate", "on"], { cwd: repo, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadState(repo).config.stopReviewGate, true);
});
