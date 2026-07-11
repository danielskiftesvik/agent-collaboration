import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeReviews } from "../core/merge-reviews.mjs";

const finding = (over = {}) => ({
  severity: "medium", title: "t", body: "b", file: "a/File.swift",
  line_start: 10, line_end: 12, confidence: 0.9, recommendation: "fix", ...over
});
const leg = (worker, verdict, findings, status = "completed") => ({
  worker, result: { status, resultValid: status === "completed", artifact: { verdict, summary: "s", findings, next_steps: [] } }
});

test("agreements dedupe by file+line proximity; more severe copy wins; workers tagged", () => {
  const m = mergeReviews([
    leg("codex", "needs-attention", [finding({ severity: "high", title: "Missing auth guard" })]),
    leg("agy", "needs-attention", [finding({ line_start: 11, severity: "medium", title: "Auth guard missing" })])
  ]);
  assert.equal(m.findings.length, 1);
  assert.equal(m.findings[0].agreement, true);
  assert.deepEqual([...m.findings[0].workers].sort(), ["agy", "codex"]);
  assert.equal(m.findings[0].severity, "high");
  assert.equal(m.findings[0].title, "Missing auth guard");
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

test("failed legs make the aggregate incomplete", () => {
  const bad = { worker: "agy", result: { status: "failed", failureKind: "timeout" } };
  const m = mergeReviews([leg("codex", "approve", []), bad]);
  assert.equal(m.verdict, "incomplete");
  assert.equal(m.provisionalVerdict, "approve");
  assert.equal(m.complete, false);
  assert.deepEqual(m.failedLegs, [{ worker: "agy", status: "failed", failureKind: "timeout" }]);
  const none = mergeReviews([bad]);
  assert.equal(none.verdict, "incomplete");
  assert.equal(none.provisionalVerdict, "unknown");
});

test("same-worker same-file findings do NOT merge with each other", () => {
  const m = mergeReviews([
    leg("codex", "needs-attention", [finding({ line_start: 10 }), finding({ line_start: 11, title: "second" })])
  ]);
  assert.equal(m.findings.length, 2);
});

test("critical findings sort first and win a severity disagreement", () => {
  const m = mergeReviews([
    leg("claude", "needs-attention", [finding({ severity: "critical", title: "critical copy" })]),
    leg("codex", "needs-attention", [finding({ line_start: 11, severity: "low", title: "critical copy" })])
  ]);
  assert.equal(m.findings.length, 1);
  assert.equal(m.findings[0].severity, "critical");
  assert.equal(m.findings[0].title, "critical copy");

  const ordered = mergeReviews([
    leg("claude", "needs-attention", [finding({ severity: "low", file: "low.swift" })]),
    leg("codex", "needs-attention", [finding({ severity: "critical", file: "critical.swift" })])
  ]);
  assert.equal(ordered.findings[0].severity, "critical");
});

test("a failed requested leg makes the merged review incomplete, not approved", () => {
  const bad = { worker: "agy", result: { status: "failed", failureKind: "timeout" } };
  const m = mergeReviews([leg("claude", "approve", []), bad]);
  assert.equal(m.complete, false);
  assert.equal(m.verdict, "incomplete");
  assert.equal(m.provisionalVerdict, "approve");
});

test("different issues on nearby lines are preserved instead of claimed as agreement", () => {
  const m = mergeReviews([
    leg("claude", "needs-attention", [finding({ title: "Authorization bypass", body: "auth guard missing" })]),
    leg("codex", "needs-attention", [finding({ line_start: 11, title: "Closure memory leak", body: "service retained" })])
  ]);
  assert.equal(m.findings.length, 2);
  assert.ok(m.findings.every((f) => f.agreement === false));
});

test("an invalid artifact never counts as a completed review leg", () => {
  const invalid = leg("agy", "approve", []);
  invalid.result.resultValid = false;
  const merged = mergeReviews([leg("claude", "approve", []), invalid]);
  assert.equal(merged.complete, false);
  assert.equal(merged.verdict, "incomplete");
  assert.deepEqual(merged.reviewers, ["claude"]);
});
