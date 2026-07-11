import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { validate, extractJson, normalizeReviewArtifact, coerceArtifact } from "../core/schema.mjs";

const reviewSchema = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../schemas/review-output.schema.json", import.meta.url)))
);

function validReview() {
  return {
    verdict: "needs-attention",
    summary: "One issue found.",
    findings: [
      {
        severity: "high",
        title: "Null deref",
        body: "x may be null",
        file: "a.js",
        line_start: 3,
        line_end: 3,
        confidence: 0.8,
        recommendation: "guard it"
      }
    ],
    next_steps: ["add a guard"]
  };
}

test("validate accepts a well-formed review", () => {
  const r = validate(reviewSchema, validReview());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("validate rejects a missing required field", () => {
  const v = validReview();
  delete v.summary;
  const r = validate(reviewSchema, v);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /summary/.test(e)));
});

test("validate rejects an out-of-enum value", () => {
  const v = validReview();
  v.verdict = "lgtm";
  assert.equal(validate(reviewSchema, v).valid, false);
});

test("validate rejects unexpected properties when additionalProperties is false", () => {
  const v = validReview();
  v.extra = 1;
  assert.equal(validate(reviewSchema, v).valid, false);
});

test("validate rejects a wrong type in a nested array item", () => {
  const v = validReview();
  v.findings[0].line_start = "3"; // should be integer
  assert.equal(validate(reviewSchema, v).valid, false);
});

test("review validation tolerates qualitative confidence and missing line numbers", () => {
  // Real models (even codex) often return confidence as a word and omit line
  // numbers when reviewing a pasted snippet. We validate post-hoc (no outputSchema
  // enforcement), so the contract must accept what models actually produce.
  const v = {
    verdict: "needs-attention",
    summary: "risky",
    findings: [
      { severity: "high", title: "t", body: "b", file: "bank.py", confidence: "high", recommendation: "fix it" }
    ],
    next_steps: []
  };
  const r = validate(reviewSchema, v);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("normalizeReviewArtifact lowercases/trims severity + verdict (codex emits 'High')", () => {
  const v = {
    verdict: " Needs-Attention ",
    summary: "s",
    findings: [
      { severity: "High", title: "t", body: "b" },
      { severity: "CRITICAL", title: "t2", body: "b2" }
    ]
    // note: no next_steps
  };
  const n = normalizeReviewArtifact(v);
  assert.equal(n.verdict, "needs-attention");
  assert.equal(n.findings[0].severity, "high");
  assert.equal(n.findings[1].severity, "critical");
  assert.ok(Array.isArray(n.next_steps), "missing next_steps becomes []");
});

test("normalizeReviewArtifact maps common severity synonyms", () => {
  const n = normalizeReviewArtifact({
    verdict: "approve",
    summary: "s",
    findings: [
      { severity: "Blocker", title: "t", body: "b" },
      { severity: "warning", title: "t", body: "b" },
      { severity: "nit", title: "t", body: "b" }
    ]
  });
  assert.equal(n.findings[0].severity, "critical");
  assert.equal(n.findings[1].severity, "medium");
  assert.equal(n.findings[2].severity, "low");
});

test("coerceArtifact with the review normalizer accepts a capitalized-severity report", () => {
  const raw = JSON.stringify({
    verdict: "Approve",
    summary: "looks fine",
    findings: [{ severity: "High", title: "t", body: "b" }]
    // no next_steps
  });
  const r = coerceArtifact(reviewSchema, raw, normalizeReviewArtifact);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.verdict, "approve");
  assert.equal(r.value.findings[0].severity, "high");
});

test("normalizeReviewArtifact maps verdict synonyms and strips top-level extras", () => {
  const raw = JSON.stringify({
    verdict: "Approved",
    summary: "looks fine",
    findings: [],
    risk: "low"
  });
  const r = coerceArtifact(reviewSchema, raw, normalizeReviewArtifact);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.value.verdict, "approve");
  assert.equal("risk" in r.value, false);

  const changes = coerceArtifact(
    reviewSchema,
    JSON.stringify({ verdict: "request changes", summary: "fix it", findings: [] }),
    normalizeReviewArtifact
  );
  assert.equal(changes.ok, false, "requesting changes without a finding is not actionable");
  assert.equal(changes.value.verdict, "needs-attention");
  assert.ok(changes.errors.some((e) => /requires at least one finding/.test(e)));
});

test("needs-attention with zero findings is invalid, even when next_steps names work", () => {
  const r = validate(reviewSchema, {
    verdict: "needs-attention",
    summary: "There is a defect.",
    findings: [],
    next_steps: ["Fix the null dereference in a.js"]
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /requires at least one finding/.test(e)));
});

test("approve with zero findings remains valid", () => {
  const r = validate(reviewSchema, {
    verdict: "approve",
    summary: "No material defects found.",
    findings: [],
    next_steps: []
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test("a review without next_steps is valid (next_steps no longer required)", () => {
  const v = validReview();
  delete v.next_steps;
  assert.equal(validate(reviewSchema, v).valid, true, "next_steps is optional");
});

test("extractJson pulls an object out of a fenced code block", () => {
  const text = "Here is my answer:\n```json\n{\"status\":\"completed\",\"summary\":\"done\"}\n```\nthanks";
  assert.deepEqual(extractJson(text), { status: "completed", summary: "done" });
});

test("extractJson parses raw JSON and returns null for prose", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
});
