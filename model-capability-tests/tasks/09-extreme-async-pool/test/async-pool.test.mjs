import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncPool } from "../src/async-pool.mjs";

test("executes tasks and returns values", async () => {
  const pool = new AsyncPool({ concurrency: 2 });
  const val = await pool.run(async () => 42);
  assert.equal(val, 42);
});

test("respects concurrency limits", async () => {
  const pool = new AsyncPool({ concurrency: 2 });
  let active = 0;
  let maxActive = 0;
  
  const track = async (delay) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, delay));
    active--;
  };

  await Promise.all([
    pool.run(() => track(20)),
    pool.run(() => track(20)),
    pool.run(() => track(20)),
    pool.run(() => track(20))
  ]);

  assert.equal(maxActive, 2);
});

test("supports pause and resume", async () => {
  const pool = new AsyncPool({ concurrency: 1 });
  const log = [];
  
  pool.run(async () => { log.push("1"); });
  pool.pause();
  pool.run(async () => { log.push("2"); });
  
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log, ["1"]); // task 2 is paused
  
  pool.resume();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(log, ["1", "2"]);
});

test("handles task timeouts and frees execution slots", async () => {
  const pool = new AsyncPool({ concurrency: 1 });
  
  // Running a slow task that times out
  let resolvedAfterTimeout = false;
  const slowTask = () => new Promise((resolve) => {
    setTimeout(() => {
      resolvedAfterTimeout = true;
      resolve("done");
    }, 50);
  });

  await assert.rejects(
    pool.run(slowTask, { timeout: 20 }),
    /Timeout/
  );

  // Immediate subsequent task must run since slot was freed
  const val = await pool.run(async () => "next", { timeout: 100 });
  assert.equal(val, "next");

  // Ensure that the timed-out task resolving later doesn't break pool state
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolvedAfterTimeout, true);
});

test("supports retries with exponential backoff", async () => {
  const pool = new AsyncPool({ concurrency: 1 });
  let attempts = 0;
  const timings = [];

  const task = () => {
    attempts++;
    timings.push(Date.now());
    if (attempts < 3) {
      return Promise.reject(new Error("failed"));
    }
    return Promise.resolve("success");
  };

  const val = await pool.run(task, { retries: 3 });
  assert.equal(val, "success");
  assert.equal(attempts, 3);
  
  // Check backoff intervals (10 * 2^attempt ms: 10ms for attempt 1, 20ms for attempt 2)
  const diff1 = timings[1] - timings[0];
  const diff2 = timings[2] - timings[1];
  assert.ok(diff1 >= 8, `Attempt 1 backoff was too fast: ${diff1}ms`);
  assert.ok(diff2 >= 18, `Attempt 2 backoff was too fast: ${diff2}ms`);
});
