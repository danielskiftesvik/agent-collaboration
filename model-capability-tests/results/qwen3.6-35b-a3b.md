# qwen3.6-35b-a3b

## 2026-07-02

Via LM Studio (`http://127.0.0.1:1234/v1`), `qwen` CLI (v0.19.4), `--bare
--approval-mode yolo --allowed-tools glob,read_file,write_file,edit,run_shell_command
--exclude-tools web_fetch --output-format json`. Model identity verified via a
direct `/v1/chat/completions` call before starting, plus a pre-flight
tool-calling sanity check and a padded ~7600-token long-context sanity check
(both clean — no recurrence of the engine-level crashes seen when
`glm-4.7-flash-mlx` and `openai/gpt-oss-20b` were first loaded in this
environment). Tasks 01-04 at 240-300s wall-time; 05 at 300s; 06-08 at 480s. One
attempt per task — none needed a retry.

| Task | Result | Calls | Wall time | Notes |
|---|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ~14s | Exact match to reference. Valid JSON status |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ~9s | Exact match to reference, correctly diagnosed and described the bug. Valid JSON status |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | ~11s | Own correct implementation, logically equivalent to the reference. Valid JSON status |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | ~11s | Correct branch placement, all existing behavior preserved. Valid JSON status |
| 05-very-hard-new-module | ✅ 8/8 | 1 | ~23s | **Same `write_file`-declined-by-yolo-mode quirk that has now hit every MoE-family model in this suite (`ornith-1.0-35b-mtplx`, `openai/gpt-oss-20b`, `qwen/qwen3.6-27b`) on this task.** Declined twice in a row, then self-recovered within the same call via `run_shell_command` (`mkdir -p ... && cat > file <<'EOF'`) — same recovery pattern as `ornith-1.0-35b-mtplx` and `qwen/qwen3.6-27b`. Clean Map-based LRU implementation, all 8 tests passed. Valid JSON status |
| 06-extreme-genuine-reasoning | ✅ 7/7 | 1 | ~21s (of 480s budget) | First try. Weighted interval scheduling via DP with binary search (sorted by end time) — same sophisticated approach as `ornith-1.0-35b-mtplx`'s and `qwen/qwen3.6-27b`'s runs. Both adversarial trap cases passed. Valid JSON status |
| 07-extreme-subtle-debugging | ✅ 5/5 | 1 | ~14s (of 480s budget) | First try. Correctly diagnosed the mutate-while-iterating bug, applied `i--` after `splice`. Valid JSON status |
| 08-extreme-rule-synthesis | ✅ 8/8 | 1 | ~18s (of 480s budget) | First try. Exact rule order matches the spec (guard, floor base, member doubling, electronics bonus after doubling, first-purchase bonus off the original amount) — both adversarial rule-ordering traps navigated correctly. Valid JSON status |

**Summary: clean sweep, 8/8 tasks, 1 call each, zero manual corrections, valid
JSON status every single time — and the fastest clean sweep of any model tested
in this suite so far.** Wall times ranged 9-23s across all 8 tasks, including the
480s-budgeted "extreme" tier, vs. `ornith-1.0-35b-mtplx`'s 15-41s (previously the
fastest) and `qwen/qwen3.6-27b`'s notably slower 45-79s despite being a similarly
sized/related model. That's a wide latency spread across three same-family (Qwen
3.5/3.6-lineage MoE) models with otherwise-identical correctness profiles — a
reminder that even within one model family, quantization, specific fine-tune, and
routing behavior matter more than raw parameter count for local-inference speed.
Task 05 produced the fourth independent instance of the `write_file`-declined
tool-approval quirk in this suite (declined twice before recovery, more
persistent than the single-decline cases seen elsewhere) and the fourth confirmed
case of a model recovering from it — every model that has hit this quirk except
`qwen3-coder-30b-a3b-instruct` has found *some* working fallback (shell heredoc,
`edit` with an empty `old_string`, or an honest "blocked" self-report), suggesting
it's specifically qwen3-coder's session-management/retry behavior that's fragile
here, not the underlying tool-approval bug itself. No engine-level or KV-cache
crashes were observed anywhere in this run.

### 2026-07-02 — full re-run, including 4 new tasks (09-12)

Re-ran all 8 original tasks fresh (same config/budgets as above) to check
reproducibility, plus ran the 4 newly-added tasks in `../tasks/` for the first
time against any model. Before benchmarking, verified each new task the same way
this suite's own convention requires: starting stub fails a known subset (09: 0/5,
10: 0/5, 11: 2/4, 12: 0/4) and the reference `solution/` passes all tests (09: 5/5,
10: 5/5, 11: 4/4, 12: 4/4). New tasks 09-12 at 480s wall-time, doubled to 960s on
one timeout (see 10, below) — same "extreme" tier budget as 06-08, since all four
require the same kind of extended, self-contained reasoning/implementation work.

| Task | Result | Calls | Wall time | Notes |
|---|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ~10s | Reproduced cleanly |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ~9s | Reproduced cleanly |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | ~12s | Reproduced cleanly |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | ~11s | Reproduced cleanly |
| 05-very-hard-new-module | ✅ 8/8 | 1 | ~72s | Reproduced cleanly (correctness); ~3x slower than the original run's 23s — real run-to-run latency variance, not a regression (same pattern documented in `dreamfoundries/ornith-1.0-9b`'s reproducibility check) |
| 06-extreme-genuine-reasoning | ✅ 7/7 | 1 | ~32s | Reproduced cleanly |
| 07-extreme-subtle-debugging | ✅ 5/5 | 1 | ~20s | Reproduced cleanly |
| 08-extreme-rule-synthesis | ✅ 8/8 | 1 | ~21s | Reproduced cleanly |
| `09-extreme-async-pool` | ✅ 5/5 | 1 | ~99s (of 480s budget) | First try. Correctly implemented concurrency limiting, pause/resume, per-task timeouts that free the execution slot without affecting an already-settled promise, and exponential backoff retries (`10 × 2^attempt` ms) — the hardest of the new tasks by requirement count, solved cleanly in one call |
| `10-extreme-buffer-parser` | ✅ 5/5 | 2 | 480s timeout (4/5 partial progress), then ~274s (of a doubled 960s budget) | **First genuine wall-time timeout this model has hit in this suite.** Attempt 1 made real progress (135-line implementation, 4/5 passing) but ran out of the default 480s budget before finishing — a "needed more time," not "stuck," per this suite's documented timeout-doesn't-mean-failure lesson. Retried at 2x budget (960s): finished in 274s, well inside it. The fix that got the last test passing was creating a single `TextDecoder` in the constructor (reused across all `push()` calls, `{ stream: true }`) instead of a fresh one per chunk, so incomplete multi-byte UTF-8 sequences split across a buffer boundary are correctly reassembled — exactly the kind of subtle boundary bug this task is designed to catch |
| `11-extreme-multi-file-refactor` | ✅ 4/4 | 1 | ~20s | First try. Correctly threaded an optional `tx` parameter through `UserService.registerUser` and `OrderService.createOrderAndUser` into the underlying DB calls, wrapped both operations in a new transaction only when no `tx` was passed in, and preserved atomic rollback and no-`tx` backward compatibility — a 3-file refactor solved in one shot |
| `12-extreme-performance-pathfinder` | ✅ 4/4 | 1 | ~23s | First try. Implemented Dijkstra with a proper binary min-heap (O(E log V)), passing the strict 30ms/200×200-grid performance assertion at ~18ms measured. JSON status was wrapped in a markdown code fence (` ```json ... ``` `) rather than being the literal, unadorned JSON object the brief required — valid JSON once extracted, but not "ONLY a JSON object and NOTHING else" |

**Summary: 12/12 tasks passed, 13 total calls, and the original 8-task clean
sweep reproduced exactly (still 8/8) on a fresh run.** The four new "extreme"
tasks (09-12) are qualitatively different from 06-08 — less "spot the adversarial
trap in a self-contained algorithm," more "hold a larger amount of real-world
engineering context correctly at once" (async timing/state machines, streaming
buffer reassembly across chunk boundaries, a multi-file transactional refactor,
and a hard performance constraint) — and this model handled all four without a
single wrong-logic failure. The one place it showed real strain was latency, not
correctness: task 10 needed a full timeout-and-retry cycle to finish, the first
time this specific model has needed extra budget anywhere in this suite, on the
task requiring the most careful state-carrying-across-calls (buffered partial
UTF-8/quote/newline sequences) — consistent with the pattern (seen with gemma's
task 06 in the original 8-task suite) that for a capable model, the ceiling on a
hard task shows up as time-to-solve before it shows up as a wrong answer.
