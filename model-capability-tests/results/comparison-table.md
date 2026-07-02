# Cross-model comparison

Latest full run per model against the 8 tasks in `../tasks/`. See each model's own
log file for per-task notes, wall-time budgets, and run history.

| Model | Date | 01 | 02 | 03 | 04 | 05 | 06 (reasoning) | 07 (debugging) | 08 (rule synthesis) | Calls (total) | Manual corrections |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [google/gemma-4-26b-a4b-qat](google-gemma-4-26b-a4b-qat.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (2nd try, needed 2x the time budget) | ✅ | ✅ | 8 | 0 |
| [dreamfoundries/ornith-1.0-9b](dreamfoundries-ornith-1.0-9b.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ (slow: ~160s) | ❌ 2/8 (3 attempts, reproducible) | ✅ | ❌ 2/5 (2 attempts, reproducible) | ✅ | 11 | 0 |

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

Add a row here (and that model's own log file under this directory) after each
model's full run.
