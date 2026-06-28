import { test } from "node:test";
import assert from "node:assert/strict";

import { recommendWorker } from "../core/dispatch.mjs";
import { MODEL_PROFILES } from "../core/model-profiles.mjs";

const ALL = ["claude", "codex", "agy"];

test("second-opinion routes to the other strong reasoner (codex <-> claude)", () => {
  assert.equal(recommendWorker({ task: "second-opinion", driver: "claude", available: ALL }).worker, "codex");
  assert.equal(recommendWorker({ task: "second-opinion", driver: "codex", available: ALL }).worker, "claude");
});

test("write tasks never route to agy (it can't deliver a patch through the runtime)", () => {
  // agy writes to its own scratch, not the worktree, so it's excluded from writes.
  for (const task of ["mechanical", "bulk-edit", "quick-fix"]) {
    const r = recommendWorker({ task, driver: "claude", available: ALL });
    assert.notEqual(r.worker, "agy", `${task} must not pick agy`);
    assert.ok(["codex", "claude"].includes(r.worker));
  }
  // even if agy is the ONLY non-driver available, a write task won't pick it
  const r = recommendWorker({ task: "mechanical", driver: "claude", available: ["claude", "agy"] });
  assert.notEqual(r.worker, "agy");
});

test("agy is still chosen for read/scan tasks (large-context)", () => {
  assert.equal(recommendWorker({ task: "large-context", driver: "codex", available: ALL }).worker, "agy");
});

test("large-context routes to agy (context window)", () => {
  assert.equal(recommendWorker({ task: "large-context", driver: "codex", available: ALL }).worker, "agy");
});

test("hard-bug routes to a reasoner, excluding the driver", () => {
  assert.equal(recommendWorker({ task: "hard-bug", driver: "claude", available: ALL }).worker, "codex");
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
