import { test } from "node:test";
import assert from "node:assert/strict";

import { isPidAlive, isStalled, projectJobHealth } from "../core/heartbeat.mjs";

test("isPidAlive is true for this process and false for an unused pid", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(2147483646), false);
});

test("a running job with a fresh heartbeat is not stalled", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const job = {
    status: "running",
    pid: 2147483646, // dead
    heartbeatAt: "2026-06-26T11:59:50.000Z" // 10s ago
  };
  assert.equal(isStalled(job, { staleMs: 120000, now }), false);
});

test("a running job with a stale heartbeat AND a dead pid is stalled", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const job = {
    status: "running",
    pid: 2147483646, // dead
    heartbeatAt: "2026-06-26T11:55:00.000Z" // 5 min ago
  };
  assert.equal(isStalled(job, { staleMs: 120000, now }), true);
});

test("a stale heartbeat but a LIVE pid is not stalled (worker still busy)", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const job = {
    status: "running",
    pid: process.pid, // alive
    heartbeatAt: "2026-06-26T11:55:00.000Z"
  };
  assert.equal(isStalled(job, { staleMs: 120000, now }), false);
});

test("a terminal job is never stalled", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const job = { status: "completed", pid: 2147483646, heartbeatAt: "2026-06-26T10:00:00.000Z" };
  assert.equal(isStalled(job, { staleMs: 120000, now }), false);
});

test("live jobs beyond idle or hard budgets are unhealthy without being mislabeled stalled", () => {
  const now = Date.parse("2026-06-26T12:00:00.000Z");
  const hardExpired = projectJobHealth({
    status: "running",
    pid: process.pid,
    startedAt: "2026-06-26T11:30:00.000Z",
    lastProgressAt: "2026-06-26T11:59:50.000Z",
    idleMs: 600_000,
    timeoutMs: 1_200_000
  }, { now });
  assert.equal(hardExpired.live, true);
  assert.equal(hardExpired.withinHardBudget, false);
  assert.equal(hardExpired.healthy, false);
  assert.equal(hardExpired.stalled, false);
  assert.equal(hardExpired.state, "hard-timeout-exceeded");

  const idleExpired = projectJobHealth({
    status: "running",
    pid: process.pid,
    startedAt: "2026-06-26T11:50:00.000Z",
    lastProgressAt: "2026-06-26T11:49:00.000Z",
    idleMs: 600_000,
    timeoutMs: 1_200_000
  }, { now });
  assert.equal(idleExpired.live, true);
  assert.equal(idleExpired.withinIdleBudget, false);
  assert.equal(idleExpired.healthy, false);
  assert.equal(idleExpired.stalled, false);
  assert.equal(idleExpired.state, "idle-timeout-exceeded");
});
