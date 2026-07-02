# openai/gpt-oss-20b

## 2026-07-02

Via LM Studio (`http://127.0.0.1:1234/v1`), `qwen` CLI (v0.19.4), `--bare
--approval-mode yolo --allowed-tools glob,read_file,write_file,edit,run_shell_command
--exclude-tools web_fetch --output-format json`. Model identity verified via a
direct `/v1/chat/completions` call before starting.

**Blocked at first, then fixed mid-session:** the model's first two `qwen` CLI
attempts (task 01) failed instantly (1-4s) with `NotImplementedError:
RotatingKVCache Quantization NYI` — an LM Studio MLX-engine crash, isolated via a
raw `curl` request with a padded ~9000-token prompt (reproduced the crash with no
tools involved at all, confirming it was a context-length-triggered KV-cache
config issue, not a `qwen`-CLI or model-capability problem). After an LM Studio
config change, the same padded-prompt `curl` request succeeded cleanly and the
full suite below ran without a recurrence. Tasks 01-04 at 240-300s wall-time; 05
at 300s; 06-08 at 480s.

| Task | Result | Calls | Wall time | Notes |
|---|---|---|---|---|
| 01-trivial-add-entry | ✅ 4/4 | 1 | ~55s | Exact match to reference, but the session was messy en route: one `edit` call had garbled/mojibake `old_string`/`new_string` content, then a `write_file`-scale response was truncated by `max_tokens` and correctly self-rejected by the CLI's own truncation guard ("rejected to prevent writing truncated content"), then one call had a missing `file_path` param — all within the same session, self-corrected without a new CLI invocation. Final JSON status has leaked GPT-OSS "harmony" format control tokens prefixed to it: `<\|channel\|>final <\|constrain\|>JSON<\|message\|>{"status":...}` — not raw parseable JSON |
| 02-easy-fix-bug | ✅ 4/4 | 1 | ~30s | Exact match to reference. Same harmony-token leak, plus a narration prefix: `All tests passed.<\|channel\|>final <\|constrain\|>JSON<\|message\|>{"status":...}` |
| 03-moderate-implement-from-spec | ✅ 5/5 | 1 | ~34s | Own correct implementation, logically equivalent to the reference (different variable names/branch order). Clean, valid JSON status this time |
| 04-hard-extend-branching-logic | ✅ 6/6 | 1 | ~54s | Correct branch placement (`if (!express && weight > 20) return "bulk"`), all existing behavior preserved. Valid JSON status |
| 05-very-hard-new-module | ✅ 8/8 | 3 | ~28s (final attempt) | **Distinctive failure-then-recovery pattern.** Attempts 1-2: `write_file` declined by the tool-approval layer (the same yolo-mode quirk every other model in this suite has hit on this task) — but unlike other models, this one **self-reported honestly**: attempt 1 tried a nonexistent `ask_user_question` tool then correctly emitted `{"status":"blocked","summary":"Cannot create file due to permission denial.","changed":false}`; attempt 2 repeated the same blocked report (with a harmony-commentary prefix leaked into the text). Neither attempt tried `run_shell_command` as a workaround, despite having used it successfully moments earlier in attempt 1 to run (failing) tests. Attempt 3 found a different, more elegant workaround than any other model in this suite: called `edit` with an empty `old_string` (`""`), which the tool treats as "create a new file" — bypassing `write_file` entirely. Clean Map-based LRU implementation, all 8 tests passed |
| 06-extreme-genuine-reasoning | ✅ 7/7 | 1 | ~36s (of 480s budget) | First try, no retry needed. Correct DP, passed both adversarial trap cases. Valid JSON status |
| 07-extreme-subtle-debugging | ✅ 5/5 | 1 | ~40s (of 480s budget) | First try. Correctly diagnosed the mutate-while-iterating bug, applied `i--` after `splice` — same fix approach as gemma's, qwen3-coder's, and ornith-1.0-35b-mtplx's runs. Narration prefix leaked before the JSON status again (`All tests passed.{"status":...}`) |
| 08-extreme-rule-synthesis | ✅ 8/8 | 1 | ~45s (of 480s budget) | First try. Exact rule order matches the spec (guard, floor base, member doubling, electronics bonus after doubling, first-purchase bonus off the original amount) — both adversarial rule-ordering traps navigated correctly. Valid JSON status |

**Summary: 8/8 tasks passed, only 1 extra call needed (on task 05), and every
"extreme" reasoning task (06-08) solved on the first attempt with no retries —
matching ornith-1.0-35b-mtplx as the two cleanest runs in this suite.** The
underlying code quality was consistently correct and stylistically reasonable
across every task, including both adversarial traps on 06 and 08. What sets this
run apart from the others is less about correctness and more about two
model-specific quirks. First, **a leaked "harmony" response format**: GPT-OSS's
native chat template uses `<|channel|>...<|message|>` control tokens to separate
commentary from a final answer, and in roughly half of this run's tasks those
tokens (or plain narration like "All tests passed.") ended up prefixed directly
onto the JSON status instead of being stripped — the underlying JSON itself was
always syntactically valid, but not parseable as "the whole response is JSON and
nothing else," which the brief explicitly requires. Second, **an unusually honest
failure mode on task 05**: when `write_file` was declined (the same tool-approval
quirk every model in this suite hits on this task), this model didn't stall
silently (qwen3-coder-30b's pattern) — it correctly recognized the block and
self-reported `"status":"blocked"` with an accurate one-line explanation, twice,
before a third attempt found a genuinely clever workaround (`edit` with an empty
`old_string` to create a new file) that no other model in this suite discovered.
That's a real difference in self-awareness/honesty under a tool-permission
failure, distinct from raw task-solving ability. Also worth flagging for future
runs: this model's first appearance in this environment was blocked entirely by
an LM Studio KV-cache-quantization engine bug unrelated to the model itself
(`RotatingKVCache Quantization NYI`, triggered by long contexts) — resolved by an
LM Studio-side config change, not anything in this test harness. Total calls: 10
(vs. gemma's 8, ornith-1.0-35b-mtplx's 8, ornith-1.0-9b's 11, qwen3-coder-30b's
20) — tied for the best correctness/call-efficiency profile in the suite.
