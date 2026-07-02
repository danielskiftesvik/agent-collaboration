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
