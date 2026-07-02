# Cross-model comparison

Latest full run per model against the 8 tasks in `../tasks/`. See each model's own
log file for per-task notes and run history.

| Model | Date | 01 | 02 | 03 | 04 | 05 | 06 (reasoning) | 07 (debugging) | 08 (rule synthesis) | Calls (total) | Manual corrections |
|---|---|---|---|---|---|---|---|---|---|---|---|
| [google/gemma-4-26b-a4b-qat](google-gemma-4-26b-a4b-qat.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (2nd try, needed 2x the time budget) | ✅ | ✅ | 8 | 0 |

`06`'s "2nd try" note matters: at this suite's default 240s wall-time budget, gemma
produced zero output on task 06 (timed out with the starting stub untouched); at 480s
it succeeded with a genuinely sophisticated solution. Tasks 01-05 never came close to
needing extra time. If comparing other models, run 06-08 with a generous budget
(480s+) before concluding a model can't solve them — the ceiling for a capable model
shows up as latency before it shows up as wrong answers.

Add a row here (and that model's own log file under this directory) after each
model's full run.
