# Model capability tests

Five self-contained coding tasks, ordered by difficulty, for benchmarking a local
model's reliability as an unattended "implementer" (e.g. via the `qwen` CLI + LM
Studio). Each task's starting state and reference solution are verified: the
starting state fails a known subset of its tests, the solution passes all of them.

## Tasks

| # | Difficulty | What it tests |
|---|---|---|
| `01-trivial-add-entry` | Trivial | Single-line addition to an array, one file, one test file |
| `02-easy-fix-bug` | Easy | Locate and fix a one-line logic bug in a small pure function |
| `03-moderate-implement-from-spec` | Moderate | Implement a function from a doc-comment spec to satisfy a given test suite (TDD) |
| `04-hard-extend-branching-logic` | Hard | Add a new branch to existing multi-branch logic without breaking any existing branch |
| `05-very-hard-new-module` | Very hard | Create a new file/class with multiple methods from a written spec, satisfying a full given test suite |

Each task directory has:
- `BRIEF.md` — the exact prompt to hand the model (already includes the JSON-status
  contract this repo's adapters use — edit or strip that if testing a different harness).
- `src/` — the starting state (missing for task 5, since the task is to create it).
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
