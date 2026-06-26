import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { validate, extractJson } from "../core/schema.mjs";

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

test("extractJson pulls an object out of a fenced code block", () => {
  const text = "Here is my answer:\n```json\n{\"status\":\"completed\",\"summary\":\"done\"}\n```\nthanks";
  assert.deepEqual(extractJson(text), { status: "completed", summary: "done" });
});

test("extractJson parses raw JSON and returns null for prose", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
});
