Implement `AsyncPool` in `src/async-pool.mjs` to satisfy its specifications and pass all tests in `test/async-pool.test.mjs`. Currently, it throws "not implemented".

### Requirements:
1. **Concurrency Limits:** Do not run more than the specified concurrency limit of tasks simultaneously.
2. **Task Timing & Execution:** The `run(task, options)` method accepts a task function (returning a Promise) and options. It returns a Promise resolving or rejecting with the task's outcome.
3. **Timeouts:** A task option `timeout` rejects the returned promise early if the task exceeds the duration. If a task times out, its execution slot must be freed immediately, and subsequent task resolutions must not affect the pool's state or resolve/reject the already-settled promise.
4. **Retries with Backoff:** A task option `retries` allows retrying a failed task up to $R$ times. Backoff should be $10 \times 2^{\text{attempt}} \text{ ms}$ (exponential backoff starting at 10ms).
5. **Pause & Resume:** `pause()` stops queue dispatching; active tasks continue. `resume()` restarts queue dispatching.

Do not edit the test file.

Then run: node --test test/async-pool.test.mjs
Expected: all tests pass.

When finished, return ONLY a JSON object:
{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}
