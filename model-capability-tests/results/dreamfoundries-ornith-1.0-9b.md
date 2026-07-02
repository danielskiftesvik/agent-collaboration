# dreamfoundries/ornith-1.0-9b

## 2026-07-02

Via LM Studio (`http://127.0.0.1:1234/v1`), `qwen` CLI, `--bare --approval-mode yolo
--allowed-tools glob,read_file,write_file,edit,run_shell_command --exclude-tools
web_fetch --output-format json`. Tasks 01-04 at 240-300s wall-time; 05-08 at
520s (per the timeout lesson learned from gemma's run — see `README.md`).

| Task | Result | Calls | Wall time | Notes |
|---|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ~22s | Exact match to reference |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ~21s | Correctly diagnosed and fixed |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | ~34s | Own correct implementation |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | **~160s** | Correct, but notably slower than gemma's equivalent (a few seconds) even at this pre-"extreme" tier |
| 05-very-hard-new-module | ❌ 2/8 | 3 attempts (300s, ~600s killed by an unrelated tooling timeout, 520s) | timed out every time | **Reproducible failure, not a timeout artifact.** Two independent attempts produced two different broken architectures: (1) a Map plus a separate, never-initialized `insertionOrder` tracking structure, and a self-referencing `size` setter; (2) a proper doubly-linked-list + Map design (the textbook-correct O(1) approach — more sophisticated than this suite's own simpler reference) but with a `Node` class exposing only a private `#value` with no accessor (so `node.value` is always `undefined`), a reference to an undefined variable `valueOfExisting`, and `_evict()` destructuring `#tail` as a `[key, node]` tuple when nothing ever stored it that way. Both times: the right high-level shape, broken wiring of the details. |
| 06-extreme-genuine-reasoning | ✅ 7/7 | 1 | ~44s | Clean, correct DP — same approach as the reference, comparable speed to gemma's (~69s) run of the same task |
| 07-extreme-subtle-debugging | ❌ 2/5 | 2 attempts (520s each) | timed out both times | **Reproducible failure.** First attempt's partial fix added a redundant `else { i++; }` while the for-loop's own `i++` still fires too — now double-incrementing on non-matches, actively worse than the starting bug (which was 3/5). Second attempt: same 2/5 result. |
| 08-extreme-rule-synthesis | ✅ 8/8 | 1 | ~42s | Exact match to reference, both adversarial ordering traps navigated correctly |

**Summary: 5/8 solved cleanly (including both "extreme" tasks that require
self-contained algorithmic/spec reasoning — 06 and 08), but 2/8 failed
reproducibly even with 2-3x the wall-time budget gemma needed.** The pattern is
not "smaller model is uniformly weaker" — it's specific: ornith matched or came
close to gemma on tasks that reward reasoning about a self-contained mathematical
structure (dynamic programming, a prose rule spec), but consistently failed tasks
requiring it to track mutable state correctly across several interacting pieces
(a stateful class with multiple private fields/methods in 05; precise
index-vs-mutation semantics in 07) — in both failing cases it durably lost track
of *which* variable meant *what* partway through, and extra time did not fix that
the way it fixed gemma's task 06 slowness. Also notable: even on an *easy-tier*
mechanical task (04), it took ~160s vs. gemma's few seconds, despite getting it
right — the speed gap shows up well before the correctness gap does.
