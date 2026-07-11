import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeReviews } from "../core/merge-reviews.mjs";

const finding = (over = {}) => ({
  severity: "medium", title: "t", body: "b", file: "a/File.swift",
  line_start: 10, line_end: 12, confidence: 0.9, recommendation: "fix", ...over
});
const leg = (worker, verdict, findings, status = "completed") => ({
  worker, result: { status, artifact: { verdict, summary: "s", findings, next_steps: [] } }
});

test("agreements dedupe by file+line proximity; more severe copy wins; workers tagged", () => {
  const m = mergeReviews([
    leg("codex", "needs-attention", [finding({ severity: "high", title: "codex title" })]),
    leg("agy", "needs-attention", [finding({ line_start: 11, severity: "medium", title: "agy title" })])
  ]);
  assert.equal(m.findings.length, 1);
  assert.equal(m.findings[0].agreement, true);
  assert.deepEqual([...m.findings[0].workers].sort(), ["agy", "codex"]);
  assert.equal(m.findings[0].severity, "high");
  assert.equal(m.findings[0].title, "codex title");
  assert.equal(m.findings[0].severityDisagreement, true);
});

test("unique findings survive tagged with their reviewer; verdict is worst-of", () => {
  const m = mergeReviews([
    leg("codex", "approve", [finding({ file: "x.swift", line_start: 1 })]),
    leg("agy", "needs-attention", [finding({ file: "y.swift", line_start: 99, severity: "high" })])
  ]);
  assert.equal(m.verdict, "needs-attention");
  assert.equal(m.findings.length, 2);
  assert.equal(m.findings[0].severity, "high"); // sorted most-severe first
  assert.ok(m.findings.every((f) => f.agreement === false && f.workers.length === 1));
});

test("failed legs are reported, not fatal; all-failed yields unknown verdict", () => {
  const bad = { worker: "agy", result: { status: "failed", failureKind: "timeout" } };
  const m = mergeReviews([leg("codex", "approve", []), bad]);
  assert.equal(m.verdict, "approve");
  assert.deepEqual(m.failedLegs, [{ worker: "agy", status: "failed", failureKind: "timeout" }]);
  const none = mergeReviews([bad]);
  assert.equal(none.verdict, "unknown");
});

test("same-worker same-file findings do NOT merge with each other", () => {
  const m = mergeReviews([
    leg("codex", "needs-attention", [finding({ line_start: 10 }), finding({ line_start: 11, title: "second" })])
  ]);
  assert.equal(m.findings.length, 2);
});
