# ornith-1.0-35b-mtplx

## 2026-07-02

Via LM Studio (`http://127.0.0.1:1234/v1`), `qwen` CLI (v0.19.4), `--bare
--approval-mode yolo --allowed-tools glob,read_file,write_file,edit,run_shell_command
--exclude-tools web_fetch --output-format json`. Model identity verified via a direct
`/v1/chat/completions` call before starting — both the `model` and
`system_fingerprint` fields echoed back `ornith-1.0-35b-mtplx`. Tasks 01-05 at
240-300s wall-time; 06-08 at 480s (per the timeout lesson in `README.md`). One
attempt per task — none needed a retry.

| Task | Result | Calls | Wall time | Notes |
|---|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ~15s | Exact match to reference. Valid JSON status |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ~15s | Exact match to reference, correctly diagnosed and described the bug in its summary. Valid JSON status |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | ~26s | Own correct implementation — different style from reference (`.substring()`/explicit length checks vs `.slice()`), logically equivalent. Valid JSON status |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | ~22s | Correct branch placement (`if (weight > 20) return "bulk"; return "large";` — logically equivalent ordering to the reference's inverted check), all existing behavior preserved. Valid JSON status |
| 05-very-hard-new-module | ✅ 8/8 | 1 | ~41s | **Notable recovery within a single call:** `write_file` was declined by the tool-approval layer (the same yolo-mode quirk this repo's `adapters/qwen.mjs` and the qwen3-coder-30b run both hit) — but instead of giving up, the model immediately fell back to `run_shell_command` with a `cat > file <<'EOF' ... EOF` heredoc to create the file, then proceeded normally. Clean Map + delete/reinsert LRU implementation with private `#capacity`/`#map` fields, correctly using `Map`'s insertion-order iteration to find the LRU key. Valid JSON status |
| 06-extreme-genuine-reasoning | ✅ 7/7 | 1 | ~27s (of 480s budget) | First try. Implemented an O(n log n) binary-search DP (sort by end time, binary search for the last non-overlapping meeting) — a more sophisticated approach than this suite's own O(n²) reference, correctly passing both adversarial trap cases. Valid JSON status |
| 07-extreme-subtle-debugging | ✅ 5/5 | 1 | ~17s (of 480s budget) | First try. Correctly diagnosed the mutate-while-iterating bug and applied `i--` after `splice` — same fix approach as gemma's and qwen3-coder's runs. Valid JSON status |
| 08-extreme-rule-synthesis | ✅ 8/8 | 1 | ~29s (of 480s budget) | First try. Exact rule order from the summary matches the spec precisely (zero/negative guard, floor base, member doubling, electronics bonus after doubling, first-purchase bonus off the original amount) — both adversarial rule-ordering traps navigated correctly. Valid JSON status |

**Summary: clean sweep, 8/8 tasks, 1 call each, zero manual corrections, valid JSON
status every single time — the cleanest run of any model tested against this suite
so far.** Unlike gemma's run (also 8/8, but task 06 needed a 2nd call after a
zero-progress timeout at the default budget), ornith-1.0-35b-mtplx solved every
task including both "extreme" reasoning tasks (06, 08) on the first attempt, with
wall times consistently in the 15-40s range even at the 480s-budgeted tier — no
sign of the latency-before-correctness-ceiling pattern seen in gemma's task 06 or
smaller ornith-1.0-9b's uniformly slower runs. The one operationally interesting
moment was task 05's `write_file` decline: rather than stalling out the way
qwen3-coder-30b-a3b-instruct did on the identical tool-approval quirk, this model
recovered within the same call by using `run_shell_command` with a heredoc to
write the file directly — a real difference in tool-use resourcefulness, not just
raw task-solving ability. Every JSON status was valid, well-formed, and accurately
summarized what was actually done — no repair rounds needed anywhere in the run,
which stands out against every other model tested (all of which needed at least
one JSON repair round or had a call fail to complete cleanly).
