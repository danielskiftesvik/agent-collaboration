# google/gemma-4-26b-a4b-qat

## 2026-07-01

Via LM Studio (`http://127.0.0.1:1234/v1`), `qwen` CLI, `--bare --approval-mode yolo
--allowed-tools glob,read_file,write_file,edit,run_shell_command --exclude-tools
web_fetch --output-format json`. One attempt per task.

| Task | Result | Calls | Notes |
|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | Exact match to reference solution |
| 02-easy-fix-bug | ✅ 4/4 | 1 | Correctly diagnosed and fixed the bug |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | Own correct implementation — different style from reference (`.substring()` vs `.slice()`), logically equivalent |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | Correct branch placement, all existing behavior preserved |
| 05-very-hard-new-module | ✅ 8/8 | 1 | Same approach as reference (Map + delete/reinsert for LRU ordering); public fields instead of private (`#`) — stylistic only |

**Summary: clean sweep, 5/5 tasks, 1 call each, zero manual corrections, valid JSON
status every time.** No repair rounds needed on any task.
