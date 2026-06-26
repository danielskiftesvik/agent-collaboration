import { test } from "node:test";
import assert from "node:assert/strict";

import { defineAdapter } from "../adapters/contract.mjs";
import { coerceArtifact } from "../core/schema.mjs";

const resultSchema = {
  type: "object",
  required: ["status", "summary"],
  properties: {
    status: { type: "string", enum: ["completed", "failed"] },
    summary: { type: "string", minLength: 1 }
  }
};

function minimalAdapter(overrides = {}) {
  return defineAdapter({
    name: "fake",
    buildCommand: () => ({ command: "true", args: [] }),
    parseOutput: () => ({ status: "completed", summary: "ok", changed: false }),
    probe: () => ({ available: true, version: "1.0" }),
    ...overrides
  });
}

test("defineAdapter rejects an adapter missing a required method", () => {
  assert.throws(() => defineAdapter({ name: "broken" }), /buildCommand/);
});

test("defineAdapter fills capability defaults", () => {
  const a = minimalAdapter();
  assert.equal(a.supportsStructuredOutput, false);
  assert.equal(a.name, "fake");
});

test("coerceArtifact returns the validated object for good fenced output", () => {
  const raw = "```json\n{\"status\":\"completed\",\"summary\":\"done\"}\n```";
  const r = coerceArtifact(resultSchema, raw);
  assert.equal(r.ok, true);
  assert.equal(r.value.summary, "done");
});

test("coerceArtifact reports failure when no JSON is present", () => {
  const r = coerceArtifact(resultSchema, "I finished the task, all good!");
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("coerceArtifact reports schema errors for malformed JSON", () => {
  const r = coerceArtifact(resultSchema, '{"status":"weird"}');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /status|summary/.test(e)));
});
