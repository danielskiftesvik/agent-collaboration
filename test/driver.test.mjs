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

test("an actively-running Codex beats an inherited Claude env", () => {
  // Codex launched from a Claude Code shell may INHERIT CLAUDECODE; Codex's own
  // signal must win over the inherited one.
  assert.equal(detectDriver({ CLAUDECODE: "1", CODEX_THREAD_ID: "x" }), "codex");
});

test("detectDriver recognizes Claude Code's own env", () => {
  assert.equal(detectDriver({ CLAUDECODE: "1" }), "claude");
  assert.equal(detectDriver({ CLAUDE_PLUGIN_ROOT: "/x" }), "claude");
});

test("agy exposes NO detectable env signature (confirmed) — must set AGENT_COLLAB_DRIVER", () => {
  // A real agy session sets no agy/antigravity/gemini env var, so it can't be
  // auto-detected. resolveDriver falls back (non-authoritative); agy drivers set
  // AGENT_COLLAB_DRIVER=agy for correct labeling. (The native no-op footgun is
  // still impossible because a fallback driver never triggers the native path.)
  assert.equal(detectDriver({ PATH: "/usr/bin", HOME: "/Users/x" }), null);
  const r = resolveDriver({}, { PATH: "/usr/bin" });
  assert.equal(r.driver, "claude");
  assert.equal(r.source, "fallback");

  const set = resolveDriver({}, { AGENT_COLLAB_DRIVER: "agy" });
  assert.equal(set.driver, "agy");
  assert.equal(set.source, "env");
});

test("detectDriver returns null when no harness signal is present", () => {
  assert.equal(detectDriver({}), null);
});
