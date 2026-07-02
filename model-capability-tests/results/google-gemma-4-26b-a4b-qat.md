# google/gemma-4-26b-a4b-qat

## 2026-07-01

Via LM Studio (`http://127.0.0.1:1234/v1`), `qwen` CLI, `--bare --approval-mode yolo
--allowed-tools glob,read_file,write_file,edit,run_shell_command --exclude-tools
web_fetch --output-format json`. One attempt per task.

| Task | Result | Calls | Notes |
|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | Exact match to reference solution |
| 02-easy-fix-bug | ✅ 4/4 | 1 | Correctly diagnosed and fixed the bug |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | Own correct implementation — different style from reference (`.substring()` vs `.slice()`), logically equivalent |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | Correct branch placement, all existing behavior preserved |
| 05-very-hard-new-module | ✅ 8/8 | 1 | Same approach as reference (Map + delete/reinsert for LRU ordering); public fields instead of private (`#`) — stylistic only |

**Summary: clean sweep, 5/5 tasks, 1 call each, zero manual corrections, valid JSON
status every time.** No repair rounds needed on any task. Every one of these 5 tasks
maps to an extremely common, heavily-trained-on pattern (see tasks 06-08's addition to
the suite, added specifically because this run didn't show any sign of a capability
ceiling) — this result shows reliable instruction-following, not necessarily strong
reasoning.

## 2026-07-02 — reasoning tasks (06-08)

Same config as above, `--max-wall-time` noted per task (240s was the suite default;
raised where noted).

| Task | Result | Calls | Wall time (final attempt) | Notes |
|---|---|---|---|---|
| 06-extreme-genuine-reasoning | ✅ 7/7 | 2 | ~69s (of a 480s budget) | **First attempt at the default 240s budget produced zero output and zero tool calls at all — aborted by `--max-wall-time` (`FatalBudgetExceededError`, exit 55) with the starting stub completely untouched.** Retried at 480s: succeeded, and not just barely — it implemented an O(n log n) binary-search DP, a more sophisticated approach than this suite's own O(n²) reference solution, correctly passing both adversarial trap cases. |
| 07-extreme-subtle-debugging | ✅ 5/5 | 1 | ~43s | Correctly diagnosed the mutate-while-iterating bug and applied a valid fix (`i--` after `splice`) — a different, equally correct approach from this suite's reference (which iterates backward instead) |
| 08-extreme-rule-synthesis | ✅ 8/8 | 1 | ~34s | Exact match to reference solution; correctly navigated both rule-ordering adversarial traps on the first attempt |

**Summary: 3/3 solved correctly, but the difficulty is now visible — not as wrong
answers, but as latency.** Tasks 07-08 took 6-9x longer than the trivial tasks (30-45s
vs a handful of seconds), and task 06 didn't just take longer, it **completely failed
within the same time budget that comfortably covered every other task in this suite**
and only succeeded once given double the time. A fixed, tasks-1-through-5-calibrated
timeout would have silently misrecorded this as a hard failure. **Takeaway for future
runs: budget wall-time per task by expected difficulty, not one constant across the
whole suite — and record time-to-solve, not just pass/fail, since for a genuinely
capable model the ceiling shows up as "how long," before it shows up as "wrong."**

## 2026-07-02 — full re-run, including 4 new tasks (09-12)

Re-ran all 8 original tasks fresh (`--max-wall-time` 240-300s for 01-05, 480s for
06-08 — applying the task-06 timeout lesson from above directly this time, rather
than discovering it again) plus the 4 newly-added tasks in `../tasks/` (480s
each), driven autonomously via the LM Studio `lms` CLI (`lms unload -a` / `lms
load "google/gemma-4-26b-a4b-qat" --identifier "google/gemma-4-26b-a4b-qat" -y`).
A live `lms log stream` heartbeat monitor ran throughout for visibility into
long-running attempts.

| Task | Result | Calls | Wall time | Notes |
|---|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ~20s | Reproduced cleanly |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ~16s | Reproduced cleanly |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | ~20s | Reproduced cleanly |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | ~32s | Reproduced cleanly |
| 05-very-hard-new-module | ✅ 8/8 | 2 | 301s timeout (0 progress, empty `src/`), then ~24s success | **New failure mode for this task/model pair** — the original 2026-07-01 run solved this cleanly in 1 call; this time attempt 1 hit a genuine wall-time timeout with zero progress (not the `write_file`-decline quirk other models hit here — no file was ever attempted). Attempt 2 succeeded immediately. Treated as run-to-run variance, not a capability regression, since the original result was never reproduced as broken |
| 06-extreme-genuine-reasoning | ✅ 7/7 | 1 | ~51s (of 480s budget) | First try this time — going straight to the 480s budget (informed by the original run's timeout-then-retry finding) avoided repeating that 2-call pattern. Same DP approach as before |
| 07-extreme-subtle-debugging | ✅ 5/5 | 1 | ~53s | Reproduced cleanly |
| 08-extreme-rule-synthesis | ✅ 8/8 | 1 | ~37s | Reproduced cleanly |
| `09-extreme-async-pool` | ✅ 5/5 | 1 | ~69s (of 480s budget) | First try. Correctly implemented concurrency limits, pause/resume, timeout-driven slot-freeing, and exponential backoff retries |
| `10-extreme-buffer-parser` | ✅ 5/5 | 2 | 481s timeout (2/5 partial), then ~922s of a 960s budget (**session errored, but the work was actually done**) | **Most interesting result in this run.** Attempt 1 timed out with real partial progress (152 lines, 2/5). Attempt 2: after a long fix-test-retest cycle (32 assistant turns), the model wrote a corrected implementation directly via a `run_shell_command` heredoc (`cat <<'EOF' > src/csv-parser.mjs`) — and then the *session itself* errored out (`Context is too large to send safely after automatic compression... compression status: COMPRESSION_FAILED_EMPTY_SUMMARY`) before it could run the tests itself or emit any JSON status. Scored by running the real tests directly against the scratch copy (this suite's own rule: the actual test always wins over self-report) — **all 5 passed.** The underlying work was fully correct; only the CLI session's own context-management housekeeping failed, after the fact |
| `11-extreme-multi-file-refactor` | ✅ 4/4 | 1 | ~35s | First try. Correctly propagated the optional `tx` parameter through both services with atomic rollback and no-`tx` backward compatibility |
| `12-extreme-performance-pathfinder` | ✅ 4/4 | 1 | ~34s | First try. Binary min-heap Dijkstra, passing the strict performance assertion. Valid JSON status |

**Summary: 12/12 tasks passed, 15 total calls.** The original 8-task sweep
reproduced (8/8), with one new wrinkle — task 05 needed a retry this time where it
hadn't before, a reminder that even "solved" tasks can show real run-to-run
timeout variance, not just the harder 06-12 tier. The four new tasks (09-12) were
handled well overall (12 calls total across all 12 original+new tasks minus the
2 retries = matches other strong performers in this suite), but task 10 produced
this suite's first case of a **context-window exhaustion failure distinct from
every other failure mode seen so far** (wall-time timeout, idle-stream stall, or
tool-approval decline): a long, correct fix-test-retest cycle that ran the
session's context past a hard limit right as it finished, killing the process
before it could self-report — but not before the actual fix was written and
verified correct. This is a strong argument for this suite's core methodology:
scoring by running the real tests against the scratch state, never trusting
whether the CLI session itself reported success, since a model can do
everything right and still have the wrapper process fail around it.
