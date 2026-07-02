# Model capability tests

Eight self-contained coding tasks, ordered by difficulty, for benchmarking a local
model's reliability as an unattended "implementer" (e.g. via the `qwen` CLI + LM
Studio). Each task's starting state and reference solution are verified: the
starting state fails a known subset of its tests, the solution passes all of them.

**Tasks 01-05 test mechanical execution** (can the model follow instructions and edit
code without slipping up) — structural complexity rises, but every one of them maps
to an extremely common, heavily-trained-on pattern (array append, off-by-one,
query-string parsing, an if/else chain, an LRU cache). A model can solve all five by
pattern-matching to something it's seen many times, without much genuine reasoning.
If you see a model clean-sweep 01-05 in one shot each, **that alone doesn't mean it's
a strong model** — it means it can follow instructions reliably. That's a real,
useful capability, but distinct from raw reasoning capability.

**Tasks 06-08 test genuine reasoning**, specifically designed to resist
pattern-matching: each has at least one test case that a plausible-looking but wrong
"shortcut" solution fails, verified directly (a naive implementation was written and
confirmed to fail exactly the intended trap case, for every one of these three). A
model that clean-sweeps 01-05 but starts failing around 06-08 is showing you the
actual edge of its reasoning ability — that's the more informative signal if you're
trying to establish a real capability hierarchy, not just an instruction-following one.

## Tasks

| # | Difficulty | What it tests |
|---|---|---|
| `01-trivial-add-entry` | Trivial | Single-line addition to an array, one file, one test file |
| `02-easy-fix-bug` | Easy | Locate and fix a one-line logic bug in a small pure function |
| `03-moderate-implement-from-spec` | Moderate | Implement a function from a doc-comment spec to satisfy a given test suite (TDD) |
| `04-hard-extend-branching-logic` | Hard | Add a new branch to existing multi-branch logic without breaking any existing branch |
| `05-very-hard-new-module` | Very hard | Create a new file/class with multiple methods from a written spec, satisfying a full given test suite |
| `06-extreme-genuine-reasoning` | Extreme (reasoning) | Weighted interval scheduling (DP) — adversarial tests specifically fail both "pick highest priority" and "maximize count" greedy shortcuts |
| `07-extreme-subtle-debugging` | Extreme (debugging) | Fix a genuinely subtle bug (mutating an array while iterating forward over it) that isn't obvious from reading the code once |
| `08-extreme-rule-synthesis` | Extreme (spec-following) | Implement a bespoke multi-rule spec (not a named algorithm) where two plausible rule-ordering mistakes are each caught by a dedicated adversarial test |
| `09-extreme-async-pool` | Extreme (async) | Implement a concurrent task runner that supports pausing/resuming, retries with backoff, and early timeouts |
| `10-extreme-buffer-parser` | Extreme (streaming) | Implement a streaming CSV parser that processes chunks, emitting rows, and handles escaped quotes or newlines split across boundaries |
| `11-extreme-multi-file-refactor` | Extreme (refactoring) | Refactor a multi-module database query system to propagate transactions while preserving backward compatibility |
| `12-extreme-performance-pathfinder` | Extreme (performance) | Implement an efficient Dijkstra shortest-path pathfinder on a large grid using a Min-Heap under a strict CPU time budget |

Each task directory has:
- `BRIEF.md` — the exact prompt to hand the model (already includes the JSON-status
  contract this repo's adapters use — edit or strip that if testing a different harness).
- `src/` — the starting state (missing entirely for task 05, since it creates a new
  file with no prior stub; tasks 03/06/08 have a stub that throws "not implemented").
- `test/` — the verification test(s). Do not give the model the `solution/` directory.
- `solution/` — a verified-correct reference implementation, for scoring/comparison only.

## Running a task against a model

Copy the task directory to a scratch location so repeated runs start clean, then
point the model at it. This mirrors the config validated in this repo's
`docs/superpowers/specs/2026-07-01-qwen-local-harness-design.md` pilot: `--bare`,
explicit `--allowed-tools` (yolo mode alone was found to still decline some tool
calls), `--output-format json` (not `stream-json` — found to reliably fail to
complete multi-turn sessions), pinned to a local endpoint.

```bash
TASK=03-moderate-implement-from-spec
MODEL=dreamfoundries/ornith-1.0-9b   # whatever's loaded in LM Studio

SCRATCH=$(mktemp -d)
cp -r "tasks/$TASK"/{src,test} "$SCRATCH"/ 2>/dev/null

(cd "$SCRATCH" && qwen -p "$(cat "$OLDPWD/tasks/$TASK/BRIEF.md")" \
  --bare --approval-mode yolo -m "$MODEL" \
  --allowed-tools glob,read_file,write_file,edit,run_shell_command \
  --openai-base-url http://127.0.0.1:1234/v1 --openai-api-key lm-studio --auth-type openai \
  --exclude-tools web_fetch \
  --output-format json \
  --max-wall-time 240s)

# score: does it actually pass, regardless of what the model claimed?
find "$SCRATCH/test" -name '*.test.mjs' -exec node --test {} +
```

Use an explicit file path for `node --test` (e.g. `test/clamp.test.mjs`), not a bare
`test/` directory argument — that silently mis-resolves on some Node versions.

## Scoring

Record results in `results/` — one log file per model (append a dated section per
run, don't overwrite), plus `results/comparison-table.md` for the cross-model view.
See `results/README.md` for the exact format.

For each (model, task) pair, record:
- **Calls needed** — how many separate invocations before the tests passed (a
  single big multi-step brief often stalls partway through; smaller, single-purpose
  follow-up calls tend to finish — see the harness-prompting `qwen.md` guide).
- **Corrections needed** — did the model's own edits contain bugs (wrong logic,
  typos, unrelated collateral changes) that a human had to fix, even if the final
  test run passed?
- **JSON status validity** — did the final reply parse as valid JSON matching the
  requested shape? (Found unreliable even when the underlying code was correct —
  budget for a repair round as the norm, not the exception.)

The actual test always wins over the model's self-report — run `node --test`
yourself against the scratch copy regardless of what status JSON came back.
