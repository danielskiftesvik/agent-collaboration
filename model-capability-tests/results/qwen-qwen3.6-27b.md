# qwen/qwen3.6-27b

## 2026-07-02

Via LM Studio (`http://127.0.0.1:1234/v1`), `qwen` CLI (v0.19.4), `--bare
--approval-mode yolo --allowed-tools glob,read_file,write_file,edit,run_shell_command
--exclude-tools web_fetch --output-format json`. Model identity verified via a
direct `/v1/chat/completions` call before starting, plus a pre-flight tool-calling
sanity check (a 1-tool schema request) and a padded ~7600-token long-context sanity
check (both clean — no recurrence of the KV-cache/engine crashes seen when
`glm-4.7-flash-mlx` and `openai/gpt-oss-20b` were first loaded in this
environment). Tasks 01-04 at 240-300s wall-time; 05 at 300s; 06-08 at 480s. One
attempt per task — none needed a retry.

| Task | Result | Calls | Wall time | Notes |
|---|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ~73s | Exact match to reference. Valid JSON status |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ~45s | Exact match to reference, correctly diagnosed and described the bug. Valid JSON status |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | ~57s | Own correct implementation, logically equivalent to the reference. Valid JSON status |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | ~46s | Correct branch placement, all existing behavior preserved. Valid JSON status |
| 05-very-hard-new-module | ✅ 8/8 | 1 | ~79s | **Same `write_file`-declined-by-yolo-mode quirk every other model in this suite has hit on this task — self-recovered within the same call.** `write_file` was declined (used `new_file_content` as the param name, notably different from `content`); the model immediately fell back to `run_shell_command` with a `cat > file <<'EOF'` heredoc, same recovery pattern as `ornith-1.0-35b-mtplx`. Clean private-field Map-based LRU implementation. Valid JSON status |
| 06-extreme-genuine-reasoning | ✅ 7/7 | 1 | ~73s (of 480s budget) | First try. Implemented weighted interval scheduling via DP with binary search (sorted by end time) — same sophisticated approach as ornith-1.0-35b-mtplx's run, more advanced than this suite's own O(n²) reference. Both adversarial trap cases passed. Valid JSON status |
| 07-extreme-subtle-debugging | ✅ 5/5 | 1 | ~47s (of 480s budget) | First try. Correctly diagnosed the mutate-while-iterating bug, applied `i--` after `splice` — same fix approach as every other model in this suite that solved this task. Valid JSON status |
| 08-extreme-rule-synthesis | ✅ 8/8 | 1 | ~68s (of 480s budget) | First try. Exact rule order matches the spec (guard, floor base, member doubling, electronics bonus after doubling, first-purchase bonus off the original amount) — both adversarial rule-ordering traps navigated correctly. Valid JSON status |

**Summary: clean sweep, 8/8 tasks, 1 call each, zero manual corrections, valid
JSON status every single time — ties `ornith-1.0-35b-mtplx` for the cleanest run
in this suite (both 8/8 in 8 total calls, no retries anywhere).** The one
difference between the two is speed: this model ran consistently slower (45-79s
per task, even on the trivial tier) than `ornith-1.0-35b-mtplx`'s 15-41s, despite
being a smaller model (27B vs 35B) — a reminder that parameter count alone doesn't
predict latency in this kind of local-inference setup; quantization, MoE routing,
and reasoning-token verbosity all factor in. Like `ornith-1.0-35b-mtplx`, this
model hit the recurring `write_file`-declined-by-yolo-mode tool-approval quirk on
task 05 and recovered gracefully within the same call via a shell heredoc,
resulting in zero extra calls needed despite the hiccup — a third data point
(after `ornith-1.0-35b-mtplx` and `openai/gpt-oss-20b`'s task 05) that this
specific tool-approval quirk is a recurring, harness-level feature of this
environment rather than a one-off, and that model-side resourcefulness in
response to it varies significantly (compare `qwen3-coder-30b-a3b-instruct`,
which stalled out completely on the same quirk with zero recovery, 3 attempts,
0/8). No engine-level or KV-cache crashes were observed anywhere in this run,
unlike the two most recently tested models before it.
