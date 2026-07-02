# Cross-model comparison

Latest full run per model against the 8 tasks in `../tasks/`. See each model's own
log file for per-task notes, wall-time budgets, and run history.

## Test setup

Recorded 2026-07-02 for transparency — the same physical machine, OS, LM Studio
install, and `qwen` CLI were used for every model run in this file unless noted
otherwise in that model's own results log (e.g. a mid-run CLI auto-update).

- **Hardware:** MacBook Pro, Apple M4 Max, 14 cores (10 performance + 4
  efficiency), 36 GB unified memory.
- **OS:** macOS 26.2 (build 25C56), Darwin kernel 25.2.0, arm64.
- **Inference server:** LM Studio 0.4.18+1, OpenAI-compatible API at
  `http://127.0.0.1:1234/v1`, one model loaded at a time. Two inference engines in
  use depending on model format: `llama.cpp-mac-arm64-apple-metal-advsimd@2.23.1`
  for GGUF models, `mlx-llm-mac-arm64-apple-metal-advsimd@1.9.1` for MLX models
  (only `glm-4.7-flash-mlx` uses MLX format among the models tried here — see its
  section below for the engine-level crash that made it untestable).
- **Harness:** `qwen` CLI, v0.19.4 at time of writing (v0.19.3 for the earliest
  runs; it auto-updated mid-suite during `qwen3-coder-30b-a3b-instruct`'s task 08 —
  see that model's log). Node v22.17.0. Exact invocation shape and flags are
  documented in `../README.md`.
- **Per-model load config:** context window size and sampling params are set by
  LM Studio at model-load time (not controlled by this test harness) and mirrored
  in the `qwen` CLI's own `~/.qwen/settings.json` provider entries. At the time of
  these runs: `temperature: 0.0`, `top_p: 0.9-0.95`, `max_tokens: 4096-8192`,
  context windows ranging from 32768 (`qwen3-coder-30b-a3b-instruct`,
  `qwen3.6-35b-a3b`) up to 262144 (`dreamfoundries/ornith-1.0-9b`) depending on the
  model — see that file directly for the exact per-model figures, since it's
  mutated by the CLI/LM Studio over time and isn't reproduced verbatim here.
- **Known environment quirks affecting results**, not specific to any one model:
  a recurring tool-approval bug where `write_file` is declined by the yolo-mode
  approval layer despite being explicitly allow-listed (hits nearly every model on
  task 05, which requires creating a file from scratch — see individual model
  notes for how each one did or didn't recover from it); and, twice so far, a
  newly-loaded model's very first attempt failing instantly on an unrelated LM
  Studio engine bug unrelated to model capability (`glm-4.7-flash-mlx`'s MLX
  `swapaxes` crash, still unresolved; `openai/gpt-oss-20b`'s `RotatingKVCache`
  crash, resolved by an LM Studio config change mid-session). Always sanity-check
  a freshly loaded model with a plain chat completion *and* a tool-calling
  request before attributing a failure to the model itself.

## Results, sorted best to worst

Sort key: (1) number of tasks fully passed, descending — 8/8 ranks above 6/8
regardless of how clean the 6/8 run otherwise was; (2) among equal pass counts,
total calls needed, ascending (fewer retries = less friction to a working
result); (3) remaining ties broken by wall-time/latency profile and the severity
of any non-fatal hiccups (engine crashes recovered from, malformed JSON, etc.),
described in each model's own notes below.

| Rank | Model | Date | 01 | 02 | 03 | 04 | 05 | 06 (reasoning) | 07 (debugging) | 08 (rule synthesis) | Calls (total) | Manual corrections |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | [qwen3.6-35b-a3b](qwen3.6-35b-a3b.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ | ✅ (1st try) | ✅ (1st try) | ✅ (1st try) | ✅ (1st try) | 8 | 0 |
| 2 | [ornith-1.0-35b-mtplx](ornith-1.0-35b-mtplx.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (1st try) | ✅ (1st try) | ✅ (1st try) | 8 | 0 |
| 3 | [qwen/qwen3.6-27b](qwen-qwen3.6-27b.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ | ✅ (1st try) | ✅ (1st try) | ✅ (1st try) | ✅ (1st try) | 8 | 0 |
| 4 | [google/gemma-4-26b-a4b-qat](google-gemma-4-26b-a4b-qat.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (2nd try, needed 2x the time budget) | ✅ | ✅ | 8 | 0 |
| 5 | [openai/gpt-oss-20b](openai-gpt-oss-20b.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ | ✅ (3 attempts) | ✅ (1st try) | ✅ (1st try) | ✅ (1st try) | 10 | 0 |
| 6 | [dreamfoundries/ornith-1.0-9b](dreamfoundries-ornith-1.0-9b.md) | 2026-07-02 | ✅ | ✅ | ✅ | ✅ (slow: ~160s) | ❌ 2/8 (3 attempts, reproducible) | ✅ | ❌ 2/5 (2 attempts, reproducible) | ✅ | 11 | 0 |
| 7 | [qwen3-coder-30b-a3b-instruct](qwen3-coder-30b-a3b-instruct.md) | 2026-07-02 | ✅ | ✅ | ✅ (3 attempts) | ✅ | ❌ 0/8 (3 attempts, reproducible — tooling, not reasoning) | ✅ (2nd try) | ✅ (3rd try) | ❌ 5/8 (6 attempts, reproducible) | 20 | 0 |

Ranks 1-3 are all clean 8/8-in-8-calls sweeps, tie-broken by wall-time: `qwen3.6-35b-a3b`
(9-23s per task) edges out `ornith-1.0-35b-mtplx` (15-41s) and `qwen/qwen3.6-27b`
(45-79s) despite all three sharing the identical correctness profile.

`06`'s "2nd try" note matters: at this suite's default 240s wall-time budget, gemma
produced zero output on task 06 (timed out with the starting stub untouched); at 480s
it succeeded with a genuinely sophisticated solution. Tasks 01-05 never came close to
needing extra time for gemma. If comparing other models, run 06-08 with a generous
budget (480s+) before concluding a model can't solve them — the ceiling for a capable
model shows up as latency before it shows up as wrong answers.

The sections below are in the order each model was actually tested (a lab-notebook
history), not ranked — use the table above for the ranked view.

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

## What ornith-1.0-35b-mtplx's run actually shows

Not to be confused with the smaller `dreamfoundries/ornith-1.0-9b` above — this is
a separate, larger (35B) model in the same family, and its profile is nothing like
its smaller sibling's. Where the 9B model durably lost track of mutable state on
05 and 07, the 35B model went 8/8, 1 call each, first try — including both
"extreme" reasoning tasks (06, 08) and the LRU cache (05) that tripped up the 9B
model twice. It's the cleanest run of any of the four models benchmarked up to
that point: every JSON status was valid on the first attempt (no repair rounds
needed anywhere, a first for this suite), and wall times stayed in the 15-40s
range even on the 480s-budgeted "extreme" tier — no sign of gemma's latency
ceiling on task 06 either. Task 06 in particular got an O(n log n) binary-search
DP, a more sophisticated solution than this suite's own O(n²) reference.

The one place this model's run diverges from a pure "everything went perfectly"
story is also the most informative data point: it hit the *exact same*
`write_file`-declined-by-yolo-mode quirk that both `dreamfoundries/ornith-1.0-9b`'s
adapter pilot and qwen3-coder-30b-a3b-instruct's task 05 ran into — but instead of
stalling out (qwen3-coder's failure mode) or not being affected at all, it
recovered *within the same call*, immediately falling back to `run_shell_command`
with a `cat > file <<'EOF'` heredoc to create the file and continuing normally.
That's a genuine difference in tool-use resourcefulness under an identical
environment glitch, not just a difference in underlying coding/reasoning ability —
worth watching for in future runs against other models, since this specific
tool-approval quirk is clearly a recurring feature of this harness/CLI
combination, not a one-off. (It has now recurred on `openai/gpt-oss-20b`'s and
`qwen/qwen3.6-27b`'s task 05 runs too — see their sections below.)

## What openai/gpt-oss-20b's run actually shows

Another clean run — 8/8, only 1 extra call needed (task 05), both extreme
reasoning tasks (06, 08) solved first try. Two things distinguish it from the
others. First, a **leaked chat-template artifact**: GPT-OSS's native "harmony"
format uses `<|channel|>...<|message|>` control tokens to separate internal
commentary from a final answer, and in about half this run's tasks those tokens
(or plain narration like "All tests passed.") ended up prefixed onto the JSON
status instead of being stripped by the LM Studio/CLI integration — the JSON
itself was always syntactically valid, just not "the entire response is JSON and
nothing else" as the brief requires. Second, and more interesting: task 05 hit the
same `write_file`-declined-by-yolo-mode quirk every model in this suite has hit —
but this model's response to it was **more honest than qwen3-coder's stall and
different from ornith-1.0-35b-mtplx's silent workaround**: it correctly recognized
the block and self-reported `{"status":"blocked",...}` with an accurate
explanation, twice, before a third attempt found a genuinely novel workaround none
of the other three models discovered — calling `edit` with an empty `old_string`
to create the file, sidestepping `write_file` entirely without needing
`run_shell_command`.

Also worth recording for future runs against this environment: this model's very
first `qwen` CLI attempts (before any task-level scoring) failed instantly with an
unrelated LM Studio engine bug, `NotImplementedError: RotatingKVCache Quantization
NYI`, triggered purely by context length (reproduced independently with a raw,
tool-free `curl` request padded to ~9000 tokens). This was resolved by an LM
Studio-side config change (unlike glm-4.7-flash-mlx's still-unresolved crash,
below) — after which every task in the table above ran cleanly. If a fresh model
in this environment fails instantly on its very first attempt, check for an
engine-level crash message before concluding anything about the model itself.

## What qwen/qwen3.6-27b's run actually shows

A third model to post a clean 8/8-in-8-calls sweep, tying `ornith-1.0-35b-mtplx`
for the best correctness/friction profile in the suite (`openai/gpt-oss-20b` also
went 8/8 but needed 10 calls due to task 05 taking 3 attempts). The main
differentiator from `ornith-1.0-35b-mtplx` is speed: this model ran consistently
slower (45-79s per task, even on the trivial tier) despite being the smaller model
of the two (27B vs 35B) — parameter count alone doesn't predict latency here.
Task 05 produced the third independent instance of the `write_file`-declined
quirk in this suite, and the third distinct model response to it: like
`ornith-1.0-35b-mtplx`, this model recovered within the same call via a shell
heredoc (rather than stalling like `qwen3-coder-30b-a3b-instruct`, or
self-reporting "blocked" like `openai/gpt-oss-20b`) — good evidence this is a
harness-level quirk that different models cope with differently, not something
specific to any one model family. Both extreme reasoning tasks (06, 08) were
solved on the first attempt, including the same sophisticated O(n log n)
binary-search DP approach `ornith-1.0-35b-mtplx` used on 06. No engine-level or
KV-cache crashes were observed anywhere in this run, unlike the two most recently
tested models before it (though a pre-flight long-context sanity check was run
first, given that recent history).

## What qwen3.6-35b-a3b's run actually shows

The fourth clean 8/8 sweep in this suite, and now the fastest: 9-23s per task
across the board, edging out `ornith-1.0-35b-mtplx` (previously fastest at
15-41s) and well ahead of the closely-related `qwen/qwen3.6-27b` (45-79s despite
being the smaller model). That three-way spread among same-lineage MoE models
with an otherwise identical 8/8-in-8-calls correctness profile is itself the
finding: within this environment, wall-clock speed is not predictable from
parameter count or even model family alone. Task 05 hit the `write_file`-declined
quirk again — the fourth model in a row to hit it, and the fourth to find some
working recovery (this time a two-decline-then-heredoc pattern, slightly more
persistent than the single-decline cases seen on `ornith-1.0-35b-mtplx` and
`qwen/qwen3.6-27b`, but resolved the same way). Across five models that have now
encountered this quirk, only `qwen3-coder-30b-a3b-instruct` failed to recover —
strong enough of a pattern to say the *quirk itself* isn't what predicts
task-05 outcomes, a given model's session-retry behavior under a tool-decline is.
Both extreme reasoning tasks (06, 08) solved first try, same DP/rule-ordering
approach as its sibling models. No engine-level or KV-cache crashes anywhere in
this run (pre-flight sanity-checked first, per the now-established practice).

## What glm-4.7-flash-mlx's run shows: nothing — untestable in this environment

Attempted 2026-07-02, immediately blocked. Model identity was confirmed correct
via `/v1/chat/completions` (plain chat completions work normally), but every
tool-calling request — via the `qwen` CLI and via a raw `curl` request with a
minimal one-tool schema, bypassing the CLI entirely — fails deterministically and
near-instantly (~60-110ms, before any tokens stream) with `AttributeError: 'list'
object has no attribute 'swapaxes'`, a crash inside LM Studio's MLX inference
engine specifically in the function/tool-calling code path. This is not a model
capability issue and not fixable by retrying or adjusting wall-time budgets — it's
an engine/runtime-level incompatibility between this MLX build of GLM-4.7-flash
and tool-calling grammar-constrained decoding. No results file was written for
this model since 8/8 identical infra-crash "failures" would misrepresent it as a
capability finding rather than an environment one. Revisit if a non-MLX (GGUF)
build becomes available, or after an LM Studio/MLX runtime update.

Add a row here (and that model's own log file under this directory) after each
model's full run — then re-sort the ranked table above using the sort key
described there.
