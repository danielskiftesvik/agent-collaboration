# Cross-model comparison

Latest full run per model against the 8 tasks in `../tasks/`. See each model's own
log file for per-task notes, wall-time budgets, and run history.

| Model | Date | 01 | 02 | 03 | 04 | 05 | 06 (reasoning) | 07 (debugging) | 08 (rule synthesis) | Calls (total) | Manual corrections |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [google/gemma-4-26b-a4b-qat](google-gemma-4-26b-a4b-qat.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (2nd try, needed 2x the time budget) | ✅ | ✅ | 8 | 0 |
| [dreamfoundries/ornith-1.0-9b](dreamfoundries-ornith-1.0-9b.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ (slow: ~160s) | ❌ 2/8 (3 attempts, reproducible) | ✅ | ❌ 2/5 (2 attempts, reproducible) | ✅ | 11 | 0 |
| [qwen3-coder-30b-a3b-instruct](qwen3-coder-30b-a3b-instruct.md) | 2026-07-02 | ✅ | ✅ | ✅ (3 attempts) | ✅ | ❌ 0/8 (3 attempts, reproducible — tooling, not reasoning) | ✅ (2nd try) | ✅ (3rd try) | ❌ 5/8 (6 attempts, reproducible) | 20 | 0 |

`06`'s "2nd try" note matters: at this suite's default 240s wall-time budget, gemma
produced zero output on task 06 (timed out with the starting stub untouched); at 480s
it succeeded with a genuinely sophisticated solution. Tasks 01-05 never came close to
needing extra time for gemma. If comparing other models, run 06-08 with a generous
budget (480s+) before concluding a model can't solve them — the ceiling for a capable
model shows up as latency before it shows up as wrong answers.

## What ornith's run actually shows

Not "the 9B model is uniformly weaker than the 26B model." The failures are
task-shape-specific, not difficulty-tier-specific: ornith matched gemma cleanly on
06 (self-contained dynamic-programming reasoning) and 08 (a prose multi-rule spec)
— both "extreme" tier — while failing 05 and 07, which both require tracking
mutable state correctly across several interacting pieces (a stateful class with
multiple private fields/methods; precise index-vs-mutation semantics in a loop).
In both failures, ornith reached for a plausible, even sophisticated-looking
overall shape (a proper doubly-linked-list LRU cache in one 05 attempt — the
textbook-correct design) but durably lost track of which variable meant what
partway through, and — unlike gemma's single genuinely-slow task (06, which
extra time fixed) — more time did not resolve it (2-3 independent attempts, same
broken result each time).

Also notable: ornith was consistently slower than gemma across *every* task, not
just the ones it failed — including task 04, a mechanical, easy-tier task it got
completely right (~160s vs. gemma's few seconds). The speed gap is visible before
the correctness gap is.

## What qwen3-coder-30b-a3b-instruct's run actually shows

A third distinct failure shape. Where ornith's failures were confidently-wrong
*logic* (durably losing track of which variable meant what across 05 and 07),
qwen's two failures (05 and 08) are best described as tool-call *execution*
reliability problems layered on otherwise-sound reasoning. On task 08, the closest
attempt (5/8, of 6 total) shows the model correctly identifying the actual
rule-ordering bug in its own stated analysis, moments before the session ended
without applying the fix. On task 05, `write_file` was declined by the
tool-approval layer despite being explicitly allow-listed (the same "yolo mode
still declines a call" quirk this repo's `adapters/qwen.mjs` already documented
from its own pilot) — and since task 05 creates a module from scratch, there was
no existing file to fall back to `edit` on, and the model never tried
`run_shell_command` as a workaround. It never produced an implementation to judge
on correctness grounds at all — task 05 is the one place all three models diverge
in kind: gemma solved it cleanly, ornith produced a sophisticated-looking but
subtly broken doubly-linked-list, qwen produced nothing.

The dominant pattern across the whole run, visible even on tasks it ultimately
passed (03, 06, 07), is **sessions ending themselves prematurely** — either zero
tool calls at all despite an ample wall-time budget remaining, or a specific,
twice-reproduced bug where the model paraphrases a comment from memory instead of
reproducing `read_file`'s literal output when building `edit`'s `old_string`,
silently zero-matching the edit (hit identically on tasks 03 and 08). Calls needed:
20 total, nearly double ornith's 11 and 2.5x gemma's 8 — almost all of that gap is
retries recovering from a stalled or malformed tool call, not the model
reconsidering wrong logic. When a run did make it cleanly through to a tool call
and a test run, the code itself was consistently correct and reasonable — same DP
approach as the reference on 06, the same `i--`-after-`splice` fix gemma used on
07, exact matches to the reference on 01 and 04.

Add a row here (and that model's own log file under this directory) after each
model's full run.
