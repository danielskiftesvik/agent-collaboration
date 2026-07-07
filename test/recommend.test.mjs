import { test } from "node:test";
import assert from "node:assert/strict";

import { recommendWorker } from "../core/dispatch.mjs";
import { MODEL_PROFILES, TASK_ROUTING } from "../core/model-profiles.mjs";

const ALL = ["claude", "codex", "agy"];

test("second-opinion routes to the other strong reasoner (codex <-> claude)", () => {
  assert.equal(recommendWorker({ task: "second-opinion", driver: "claude", available: ALL }).worker, "codex");
  assert.equal(recommendWorker({ task: "second-opinion", driver: "codex", available: ALL }).worker, "claude");
});

test("fast write tasks prefer agy now that it can deliver patches", () => {
  for (const task of ["mechanical", "bulk-edit", "quick-fix"]) {
    const r = recommendWorker({ task, driver: "claude", available: ALL });
    assert.equal(r.worker, "agy", `${task} should pick agy`);
  }
  const r = recommendWorker({ task: "mechanical", driver: "claude", available: ["claude", "agy"] });
  assert.equal(r.worker, "agy");
});

test("agy is still chosen for read/scan tasks (large-context)", () => {
  assert.equal(recommendWorker({ task: "large-context", driver: "codex", available: ALL }).worker, "agy");
});

test("large-context routes to agy (context window)", () => {
  assert.equal(recommendWorker({ task: "large-context", driver: "codex", available: ALL }).worker, "agy");
});

test("hard-bug routes to a write-capable worker, excluding the driver", () => {
  const r = recommendWorker({ task: "hard-bug", driver: "claude", available: ALL });
  assert.notEqual(r.worker, "claude");
  assert.notEqual(r.worker, "codex");
  assert.notEqual(MODEL_PROFILES[r.worker]?.canWrite, false);
});

test("codex is review-only and is not recommended for write tasks", () => {
  assert.equal(MODEL_PROFILES.codex.canWrite, false);
  const r = recommendWorker({ task: "refactor", driver: "agy", available: ALL });
  assert.notEqual(r.worker, "codex");
});

test("visual and multimodal tasks route to agy", () => {
  assert.equal(recommendWorker({ task: "visual", driver: "claude", available: ALL }).worker, "agy");
  assert.equal(recommendWorker({ task: "multimodal", driver: "codex", available: ALL }).worker, "agy");
});

test("a recommendation carries the worker's model profile and a reason", () => {
  const r = recommendWorker({ task: "large-context", driver: "claude", available: ALL });
  assert.equal(r.profile.vendor, "Google");
  assert.match(r.reason, /context/i);
  assert.ok(Array.isArray(r.profile.strongerAt));
});

test("falls back to native when the only fit is the driver", () => {
  const r = recommendWorker({ task: "refactor", driver: "claude", available: ["claude"] });
  assert.equal(r.mode, "native");
  assert.equal(r.harness, "claude");
});

test("unknown task uses the default preference, excluding the driver", () => {
  const r = recommendWorker({ task: "totally-novel", driver: "claude", available: ALL });
  assert.equal(r.mode, "cross");
  assert.ok(["codex", "agy"].includes(r.worker));
});

test("MODEL_PROFILES documents stronger AND weaker traits + vendor for each harness", () => {
  for (const h of ALL) {
    assert.ok(MODEL_PROFILES[h].strongerAt.length > 0, `${h} strongerAt`);
    assert.ok(MODEL_PROFILES[h].weakerAt.length > 0, `${h} weakerAt`);
    assert.ok(MODEL_PROFILES[h].vendor, `${h} vendor`);
    assert.ok(MODEL_PROFILES[h].model, `${h} model`);
  }
});

test("a strict route returns none (not a substituted harness) when its only worker is unavailable", () => {
  const originalRouting = { ...TASK_ROUTING };
  TASK_ROUTING["test-strict-route"] = { workers: ["ghost"], why: "test fixture", strict: true };
  const r = recommendWorker({ task: "test-strict-route", driver: "claude", available: ALL });
  assert.equal(r.mode, "none");
  assert.equal(r.worker, null);
  assert.match(r.reason, /strict/i);
  delete TASK_ROUTING["test-strict-route"];
  assert.deepEqual(TASK_ROUTING, originalRouting);
});

test("a non-strict route's generic fallback never substitutes an explicitOnly harness", () => {
  const originalProfile = MODEL_PROFILES.agy;
  MODEL_PROFILES.agy = { ...originalProfile, explicitOnly: true };
  const r = recommendWorker({ task: "totally-novel", driver: "claude", available: ["agy"] });
  assert.equal(r.mode, "none");
  MODEL_PROFILES.agy = originalProfile;
});

test("an explicitOnly harness IS still returned when it's directly in the route's workers list", () => {
  const originalProfile = MODEL_PROFILES.agy;
  MODEL_PROFILES.agy = { ...originalProfile, explicitOnly: true };
  const originalRouting = { ...TASK_ROUTING };
  TASK_ROUTING["test-explicit-route"] = { workers: ["agy"], why: "test fixture", strict: true };
  const r = recommendWorker({ task: "test-explicit-route", driver: "claude", available: ALL });
  assert.equal(r.mode, "cross");
  assert.equal(r.worker, "agy");
  delete TASK_ROUTING["test-explicit-route"];
  assert.deepEqual(TASK_ROUTING, originalRouting);
  MODEL_PROFILES.agy = originalProfile;
});

test("local-only and plan-execution route to qwen when it's available", () => {
  const available = [...ALL, "qwen"];
  assert.equal(recommendWorker({ task: "local-only", driver: "claude", available: available }).worker, "qwen");
  assert.equal(recommendWorker({ task: "plan-execution", driver: "claude", available: available }).worker, "qwen");
});

test("local-only and plan-execution return none (never a cloud harness) when qwen is unavailable", () => {
  const r1 = recommendWorker({ task: "local-only", driver: "claude", available: ALL });
  const r2 = recommendWorker({ task: "plan-execution", driver: "claude", available: ALL });
  assert.equal(r1.mode, "none");
  assert.equal(r2.mode, "none");
});

test("qwen is never suggested for an existing task type it isn't routed for", () => {
  const r = recommendWorker({ task: "large-context", driver: "claude", available: ["claude", "qwen"] });
  assert.equal(r.mode, "none");
});

test("qwen profile documents stronger/weaker traits and is explicitOnly + canWrite + cleanEnv", () => {
  assert.ok(MODEL_PROFILES.qwen.strongerAt.length > 0);
  assert.ok(MODEL_PROFILES.qwen.weakerAt.length > 0);
  assert.equal(MODEL_PROFILES.qwen.explicitOnly, true);
  assert.equal(MODEL_PROFILES.qwen.canWrite, true);
  assert.equal(MODEL_PROFILES.qwen.cleanEnv, true);
  assert.equal(MODEL_PROFILES.qwen.idleMsOverride, 1800000);
});
