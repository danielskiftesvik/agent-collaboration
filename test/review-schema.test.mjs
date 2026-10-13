import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { validate, normalizeReviewArtifact, coerceArtifact } from "../core/schema.mjs";
import * as dispatch from "../core/dispatch.mjs";
import { listAdapters } from "../adapters/index.mjs";
import { mergeReviews } from "../core/merge-reviews.mjs";

// A critical review finding must carry a structured `reachable_scenario`
// string: who, on what device or tooling run, does what, and what goes wrong.
// Downstream merge gates read only that field, so a critical finding without
// it is schema-invalid rather than silently treated as non-blocking.

const reviewSchema = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../schemas/review-output.schema.json", import.meta.url)))
);

const SCENARIO =
  "A user finishes a workout offline on the Watch and the last confirmed set is dropped on sync.";
const REQUIRED_ERROR =
  "$.findings[0].reachable_scenario: required for a critical finding (who, on what device or tooling run, does what, and what goes wrong)";

function review(finding) {
  return {
    verdict: "needs-attention",
    summary: "One issue found.",
    findings: [{ title: "Lost set", body: "The final set is dropped.", ...finding }],
    next_steps: []
  };
}

// The dispatch path: normalize first, then validate.
function check(finding) {
  return coerceArtifact(reviewSchema, JSON.stringify(review(finding)), normalizeReviewArtifact);
}

test("schema declares reachable_scenario as a non-empty string on findings", () => {
  const prop = reviewSchema.properties.findings.items.properties.reachable_scenario;
  assert.ok(prop, "findings.items.properties.reachable_scenario is declared");
  assert.equal(prop.type, "string");
  assert.equal(prop.minLength, 1);
  assert.match(prop.$comment ?? "", /required when severity is critical/i);
});

test("a critical finding without reachable_scenario is invalid with the named error", () => {
  const r = check({ severity: "critical" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes(REQUIRED_ERROR), `errors: ${JSON.stringify(r.errors)}`);
});

test("a critical finding with reachable_scenario is valid", () => {
  const r = check({ severity: "critical", reachable_scenario: SCENARIO });
  assert.equal(r.ok, true, `errors: ${JSON.stringify(r.errors)}`);
  assert.equal(r.value.findings[0].reachable_scenario, SCENARIO);
});

test("synonyms that normalize to critical (blocker, crit, fatal, CRITICAL) need the field", () => {
  for (const severity of ["blocker", "crit", "fatal", " CRITICAL "]) {
    const r = check({ severity });
    assert.equal(r.ok, false, `${severity} without the field must be invalid`);
    assert.ok(r.errors.includes(REQUIRED_ERROR), `${severity}: ${JSON.stringify(r.errors)}`);
  }
});

test("validate alone also catches an un-normalized critical synonym without the field", () => {
  const { valid, errors } = validate(reviewSchema, review({ severity: "Blocker" }));
  assert.equal(valid, false);
  assert.ok(errors.includes(REQUIRED_ERROR), JSON.stringify(errors));
});

test("high, medium and low findings without reachable_scenario stay valid", () => {
  for (const severity of ["high", "medium", "low", "major", "nit"]) {
    const r = check({ severity });
    assert.equal(r.ok, true, `${severity}: ${JSON.stringify(r.errors)}`);
  }
});

test("a whitespace-only or non-string reachable_scenario on a critical is invalid", () => {
  for (const reachable_scenario of ["   ", "\n\t", "", 42, true, null, ["x y"]]) {
    const r = check({ severity: "critical", reachable_scenario });
    assert.equal(r.ok, false, `${JSON.stringify(reachable_scenario)} must be invalid`);
    assert.ok(r.errors.includes(REQUIRED_ERROR), `${JSON.stringify(reachable_scenario)}: ${JSON.stringify(r.errors)}`);
  }
});

test("normalizeReviewArtifact trims a string reachable_scenario and keeps it", () => {
  const n = normalizeReviewArtifact(review({ severity: "Critical", reachable_scenario: `  ${SCENARIO}\n` }));
  assert.equal(n.findings[0].reachable_scenario, SCENARIO);
  assert.equal(n.findings[0].severity, "critical");
});

test("the fallback reviewer instruction names the field and the rule", () => {
  assert.equal(typeof dispatch.schemaInstruction, "function", "schemaInstruction is exported");
  const text = dispatch.schemaInstruction("reviewer");
  assert.match(text, /"reachable_scenario":string/);
  assert.match(
    text,
    /reachable_scenario is REQUIRED on every critical finding: who, on what device or tooling run, does what, and what goes wrong \(the result is rejected without it\)\./
  );
  assert.doesNotMatch(dispatch.schemaInstruction("worker"), /reachable_scenario/);
});

test("every adapter's reviewer contract names the field and the rule", () => {
  for (const adapter of listAdapters()) {
    if (typeof adapter.outputContract !== "function") continue;
    const text = adapter.outputContract("reviewer");
    assert.match(text, /reachable_scenario/, `${adapter.name} reviewer contract`);
    assert.match(text, /REQUIRED on every critical finding/, `${adapter.name} reviewer contract`);
    assert.doesNotMatch(adapter.outputContract("worker"), /reachable_scenario/, `${adapter.name} worker contract`);
  }
});

test("mergeReviews keeps reachable_scenario when a later leg escalates to critical", () => {
  const base = { file: "a/File.swift", line_start: 10, line_end: 12, title: "Final set dropped on sync", body: "b" };
  const leg = (worker, findings) => ({
    worker,
    result: { status: "completed", resultValid: true, artifact: { verdict: "needs-attention", summary: "s", findings, next_steps: [] } }
  });
  const m = mergeReviews([
    leg("codex", [{ ...base, severity: "low" }]),
    leg("claude", [{ ...base, line_start: 11, severity: "critical", reachable_scenario: SCENARIO }])
  ]);
  assert.equal(m.findings.length, 1);
  assert.equal(m.findings[0].severity, "critical");
  assert.equal(m.findings[0].reachable_scenario, SCENARIO);
});
