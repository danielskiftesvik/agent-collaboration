import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFailure, isFallbackKind } from "../core/failures.mjs";

// ---- rate / subscription limits ----

test("codex 429 in stderr is a rate-limit", () => {
  const c = classifyFailure({ stderr: "Error: 429 Too Many Requests", exitCode: 1, worker: "codex" });
  assert.equal(c.kind, "rate-limit");
});

test("claude 'usage limit reached' is a rate-limit and extracts the reset time", () => {
  const c = classifyFailure({
    stdout: "I'm sorry — usage limit reached, resets at 10pm.",
    exitCode: 1,
    worker: "claude"
  });
  assert.equal(c.kind, "rate-limit");
  assert.match(c.resetAt, /10pm/);
});

test("claude 529 overloaded is treated as a rate-limit (back off / try elsewhere)", () => {
  const c = classifyFailure({ stderr: "529 overloaded_error: Overloaded", exitCode: 1, worker: "claude" });
  assert.equal(c.kind, "rate-limit");
});

test("agy RESOURCE_EXHAUSTED / quota is a rate-limit", () => {
  const c = classifyFailure({ stderr: "RESOURCE_EXHAUSTED: quota exceeded", exitCode: 1, worker: "agy" });
  assert.equal(c.kind, "rate-limit");
});

test("a 'retry-after' hint is captured as resetAt", () => {
  const c = classifyFailure({ stderr: "rate limit exceeded; retry-after: 42", exitCode: 1, worker: "codex" });
  assert.equal(c.kind, "rate-limit");
  assert.match(c.resetAt, /42/);
});

// ---- auth ----

test("a 401 / invalid api key is an auth failure", () => {
  const c = classifyFailure({ stderr: "401 Unauthorized: invalid api key", exitCode: 1, worker: "codex" });
  assert.equal(c.kind, "auth");
});

test("'please run login' is an auth failure", () => {
  const c = classifyFailure({ stdout: "Not authenticated. Please run `agy login`.", exitCode: 1, worker: "agy" });
  assert.equal(c.kind, "auth");
});

// ---- other ----

test("an ordinary error is classified as other", () => {
  const c = classifyFailure({ stderr: "TypeError: cannot read property of undefined", exitCode: 1, worker: "claude" });
  assert.equal(c.kind, "other");
  assert.equal(c.resetAt, null);
});

test("rate-limit dominates when both rate-limit and auth words appear", () => {
  const c = classifyFailure({ stderr: "429 rate limit; also check your login", exitCode: 1, worker: "codex" });
  assert.equal(c.kind, "rate-limit");
});

// ---- which kinds trigger an auto-fallback ----

test("rate-limit, auth and timeout are fallback-worthy; other is not", () => {
  assert.equal(isFallbackKind("rate-limit"), true);
  assert.equal(isFallbackKind("auth"), true);
  assert.equal(isFallbackKind("timeout"), true);
  assert.equal(isFallbackKind("other"), false);
  assert.equal(isFallbackKind(undefined), false);
});
