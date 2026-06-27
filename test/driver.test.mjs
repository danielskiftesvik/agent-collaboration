import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveDriver, detectDriver, isAuthoritativeDriver } from "../core/dispatch.mjs";

test("explicit --driver wins and is authoritative", () => {
  const r = resolveDriver({ driver: "codex" }, {});
  assert.equal(r.driver, "codex");
  assert.equal(r.source, "flag");
  assert.equal(isAuthoritativeDriver(r.source), true);
});

test("AGENT_COLLAB_DRIVER env is used and authoritative", () => {
  const r = resolveDriver({}, { AGENT_COLLAB_DRIVER: "agy" });
  assert.equal(r.driver, "agy");
  assert.equal(r.source, "env");
  assert.equal(isAuthoritativeDriver(r.source), true);
});

test("a flag beats the env", () => {
  const r = resolveDriver({ driver: "codex" }, { AGENT_COLLAB_DRIVER: "agy" });
  assert.equal(r.driver, "codex");
  assert.equal(r.source, "flag");
});

test("detection labels the driver but is NOT authoritative (must not trigger native)", () => {
  const r = resolveDriver({}, { CLAUDECODE: "1" });
  assert.equal(r.driver, "claude");
  assert.equal(r.source, "detected");
  assert.equal(isAuthoritativeDriver(r.source), false);
});

test("with nothing set, driver falls back to claude but is non-authoritative", () => {
  const r = resolveDriver({}, {});
  assert.equal(r.driver, "claude");
  assert.equal(r.source, "fallback");
  assert.equal(isAuthoritativeDriver(r.source), false);
});

test("detectDriver recognizes Codex's own env (real signals)", () => {
  // Confirmed from a live Codex session: CODEX_THREAD_ID is set every session;
  // CODEX_MANAGED_* appear for npm installs.
  assert.equal(detectDriver({ CODEX_THREAD_ID: "019f08b6-8d5e-76a0" }), "codex");
  assert.equal(detectDriver({ CODEX_MANAGED_BY_NPM: "1" }), "codex");
});

test("an actively-running harness beats an inherited Claude env", () => {
  // Codex/agy launched from a Claude Code shell may INHERIT CLAUDECODE; the
  // actively-running harness's own signal must win over the inherited one.
  assert.equal(detectDriver({ CLAUDECODE: "1", CODEX_THREAD_ID: "x" }), "codex");
  assert.equal(detectDriver({ CLAUDE_PLUGIN_ROOT: "/x", AGY_DRIVER: "1" }), "agy");
});

test("detectDriver recognizes Claude Code's own env", () => {
  assert.equal(detectDriver({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectDriver({ CLAUDE_PLUGIN_ROOT: "/x" }), "claude");
});

test("detectDriver returns null when no harness signal is present", () => {
  assert.equal(detectDriver({}), null);
});
