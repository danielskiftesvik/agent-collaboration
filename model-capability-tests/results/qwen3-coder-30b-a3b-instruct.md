# qwen3-coder-30b-a3b-instruct

## 2026-07-02

Via LM Studio (`http://127.0.0.1:1234/v1`), `qwen` CLI (v0.19.3, auto-updated to
v0.19.4 mid-run — see task 08 notes), `--bare --approval-mode yolo --allowed-tools
glob,read_file,write_file,edit,run_shell_command --exclude-tools web_fetch
--output-format json`. Model identity verified via a direct `/v1/chat/completions`
call before starting — both the `model` and `system_fingerprint` fields echoed back
`qwen3-coder-30b-a3b-instruct`, confirming LM Studio wasn't still serving a
previously-loaded model. Tasks 01-04 at 240-300s wall-time; 05 at 300s; 06-08 at
480s (per the timeout lesson in `README.md`).

| Task | Result | Calls | Wall time | Notes |
|---|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ~18s | Exact match to reference, but the self-reported JSON status was malformed — missing a colon: `{"status":"completed","summary","All tests pass...","changed":true}` |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ~12s | Correct fix, but the model never ran the tests itself or emitted any JSON status — the session ended mid-sentence right after the edit ("Now I'll run the tests to verify they all pass:") with no further tool call |
| 03-moderate-implement-from-spec | ✅ 5/5 | 3 | ~117s total (63s + 21s + 33s) | **First two attempts failed identically**: constructing the `edit` tool's `old_string`, the model paraphrased a spec comment from memory instead of reproducing the exact `read_file` output (wrote "a key with no value" instead of the actual "a key with no \"=\" (e.g. \"flag\")", and dropped a whole line) — 0 occurrences found, edit rejected, and the model gave up without retrying a smaller edit. Third attempt succeeded by scoping the edit to just the function body instead of the whole file+comments |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | ~15s | Correct branch placement, all existing behavior preserved; same malformed-JSON-status bug as task 01 |
| 05-very-hard-new-module | ❌ 0/8 | 3 attempts, all failed | ~10s / ~10s / ~6s | **Reproducible failure, environmental rather than logical.** `write_file` is declined by the tool-approval layer despite being listed in `--allowed-tools` (matches this repo's own `adapters/qwen.mjs` documented finding that yolo mode can still decline calls) — and task 05 has no existing file to `edit`, since it creates a module from scratch. Attempt 1: tried `write_file`, got declined, then gave up. Attempts 2-3: didn't even attempt a tool call — announced intent in text ("Let me create the implementation file first") and the session ended with zero tool calls each time. Never tried `run_shell_command` (e.g. a heredoc) as a workaround. No implementation ever existed to judge on correctness grounds |
| 06-extreme-genuine-reasoning | ✅ 7/7 | 2 | ~26s (of 480s budget) | First attempt ended after only 6s: a single text-only turn, zero tool calls — not a wall-time exhaustion, the session just stopped itself well inside budget. Second attempt implemented a clean, correct DP (same overall approach as the reference), passing both adversarial trap cases on the first real try |
| 07-extreme-subtle-debugging | ✅ 5/5 | 3 | ~19s (of 480s budget) | First attempt: zero tool calls, session ended after 33s. Second attempt: called `read_file` with the wrong parameter name (`path` instead of `file_path`), got a schema-validation error back, explored via `ls` instead of retrying `read_file` correctly, then gave up. Third attempt correctly diagnosed the mutate-while-iterating bug and applied `i--` after `splice` — the same fix approach gemma used |
| 08-extreme-rule-synthesis | ❌ 5/8 (best of 6 attempts) | 6 | 5-126s each (of 480s budget) | **Reproducible failure, but for varied reasons rather than one consistent wrong answer.** Attempt 1: genuine model-side stall (`[API Error: No stream activity for 120000ms after 34 chunks]` — the model was "thinking" for 2 minutes with no streamed output, tripping an idle-stream watchdog independent of `--max-wall-time`; the qwen CLI silently auto-updated 0.19.3→0.19.4 around this point). Attempt 2 got closest: correctly parsed all 4 interacting rules in its own stated analysis, wrote an implementation, ran the tests, saw 3/8 failures, correctly began re-diagnosing the rule-ordering bug in its final message — but the session ended before it applied the fix. Attempts 3-5: zero tool calls, session ended after ~5s each (one also mis-named the `read_file` parameter). Attempt 6: repeated task 03's exact failure mode — a paraphrased/reworded comment in the `edit` tool's `old_string`, 0 occurrences found, no retry. Never reached a passing state |

**Summary: 6/8 tasks eventually passed, but the failure pattern here looks
structurally different from both other models.** Gemma failed nothing; ornith
durably lost track of *which variable meant what* on two tasks requiring
multi-piece mutable-state tracking (05, 07) even with 2-3x the time budget. qwen's
two failures (05, 08) are not confidently-wrong logic in the way ornith's were —
task 08's closest attempt (5/8) shows the model correctly identifying the actual
rule-ordering bug in its own reasoning, moments before running out of session
before applying the fix. What actually failed here, repeatedly and across half the
suite, is **tool-call execution reliability**, not reasoning: (a) sessions ending
themselves prematurely with zero tool calls well inside the wall-time budget
(hit at least once each on tasks 05, 06, 07, 08); (b) a specific, twice-reproduced
bug where the model paraphrases comment text from memory instead of reproducing
`read_file`'s exact output when constructing `edit`'s `old_string`, silently
failing the edit (tasks 03 and 08); (c) occasional wrong parameter names in tool
calls (`path` instead of `file_path`); (d) malformed self-reported JSON status
(missing colons) on 2 of the tasks it otherwise solved correctly, and one task
(02) where it skipped both running its own tests and emitting any status at all.
When a run *did* make it cleanly through to a tool call and a test run, the
underlying code was consistently correct and stylistically reasonable — same DP
approach as the reference on 06, same `i--`-after-`splice` fix as gemma on 07,
exact match to reference on 01/04. Calls needed: 20 total across the suite (vs.
gemma's 8 and ornith's 11) — every point of that gap is retries recovering from a
stalled or malformed tool call, not the model reconsidering wrong logic. Task 05's
failure is also notable as the one place all three models diverge in kind: gemma
solved it cleanly, ornith produced sophisticated-looking but subtly broken
mutable-state code, and qwen never produced an implementation to judge at all,
because `write_file` was declined and it never fell back to `run_shell_command`.
