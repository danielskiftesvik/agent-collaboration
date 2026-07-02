# Results

One file per model, named after its LM Studio model id with `/` replaced by `-`
(e.g. `dreamfoundries/ornith-1.0-9b` -> `dreamfoundries-ornith-1.0-9b.md`). Each
file is a log — append a new dated section every time you re-run the suite against
that model (e.g. after a quantization change or a new version), don't overwrite.

`comparison-table.md` is the cross-model comparison table — update it whenever a new
model's full run finishes.

**Use a generous `--max-wall-time` for tasks 06-08 (480s+), not the same budget as
01-05.** Found running gemma: at a 240s budget (fine for every task in 01-05) task 06
produced zero output and zero tool calls at all — a hard timeout, not a wrong answer.
At 480s it succeeded with a genuinely sophisticated solution. For a capable model, the
difficulty of 06-08 tends to show up as *latency* before it shows up as an incorrect
answer — a too-short timeout will misrecord "needed more time" as "failed."

## Section format for a model's log file

```markdown
## YYYY-MM-DD

| Task | Result | Calls | Notes |
|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ... |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ... |
| 03-moderate-implement-from-spec | ... | ... | ... |
| 04-hard-extend-branching-logic | ... | ... | ... |
| 05-very-hard-new-module | ... | ... | ... |
| 06-extreme-genuine-reasoning | ... | ... | note the wall-time budget and actual duration used |
| 07-extreme-subtle-debugging | ... | ... | ... |
| 08-extreme-rule-synthesis | ... | ... | ... |

**Calls** = separate CLI invocations needed before the real test run (`node --test`,
not the model's self-report) passed for that task — a stalled multi-step attempt
followed by a smaller focused retry counts as 2, etc.
**Result** = ✅ N/M if all M tests eventually passed, ❌ N/M if it never got there
(record the final state, N = tests passing in the last attempt; if it hit
`--max-wall-time` with zero progress, say so explicitly — that's a timeout, not
necessarily evidence the model can't solve it, see above).
Note anything a human had to fix by hand even when the final run passed — wrong
logic, typos, unrelated collateral edits, invalid JSON status.
```

## Scope note

These results are specific to the 5 tasks in `../tasks/` — a separate, purpose-built
difficulty gradient. They are **not** directly comparable to any results from testing
a model against this repo's actual `qwen`-local-harness implementation plan (a
different, larger set of real tasks) — see that work's commit history
(`git log --oneline` on `main`, the `feat(adapters): add the qwen local-harness
adapter` commit and its neighbors) for those separate, real-world findings.
