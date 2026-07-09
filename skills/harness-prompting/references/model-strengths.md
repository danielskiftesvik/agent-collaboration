# Model strengths & routing

Which underlying model is strongest at what, and how that maps to worker choice. Mirrors
`core/model-profiles.mjs` (the code source of truth for `recommend`).

> **Two governing caveats — read first.**
> 1. **Harness > model.** The agent harness/scaffolding can swing coding outcomes
>    materially on identical model weights. So these
>    are model+**harness** tendencies, and cross-vendor rankings are only valid on
>    *same-scaffold* benchmarks. Undisclosed-harness scores are effectively non-reproducible.
> 2. **Decays fast.** Frontier models ship frequently. Version-stamped for this
>    release — edit
>    `core/model-profiles.mjs` as they evolve, and weigh task fit over vendor.

## The three underlying models

### Claude (Anthropic — Claude 5 / Opus 4.8 + Sonnet) — agentic engineer
- **Stronger at:** general SWE & careful refactoring, long-horizon agentic terminal work,
  instruction-following & scope discipline, planning.
- **Evidence:** consistently strong on agentic/terminal software-engineering workflows.
- **Weaker at:** some hardest adversarial reviews benefit from a second codex pass;
  raw speed/cost vs Gemini Flash.

### Codex (OpenAI) — reasoner / writer
- **Stronger at:** hardest contamination-resistant debugging & reasoning, algorithms, math,
  subtle bug-finding, adversarial analysis.
- **Evidence:** strongest observed value here is high-signal adversarial review and
  subtle-failure analysis.
- **Weaker at:** slower and sometimes quieter than other write-workers on large
  patches; sandbox friction when used as an implementer or driver.

### Gemini 3.x (Google — Pro / Flash) — fast, wide, multimodal
- **Stronger at:** speed & low cost (Flash tier) for high-throughput edits; multimodal input;
  large context windows for whole-repo work.
- **Weaker at:** weaker than Claude/codex on the deepest coding-reasoning reviews;
  strict JSON adherence on Flash needs the existing contracts.
- **Refuted:** the often-cited **1M-token context *advantage* over Claude/Codex did NOT survive
  adversarial verification** (0-3) — Gemini has large context, but "bigger than rivals" is
  unconfirmed.

## Task → worker

`agent-companion.mjs recommend --task <type> --driver <self>` returns the strongest *available*
worker (excluding the driver) + the model's profile + a reason. The mapping:

| Task type | Preferred | Basis |
|---|---|---|
| `second-opinion` | other of codex/claude | independence + deep reasoning |
| `hard-bug`, `architecture`, `design-tradeoff` | claude, codex, agy | Claude for disciplined edits; codex for hard reasoning; agy as fast fallback |
| `refactor`, `general-swe` | claude, agy, codex | Claude for careful implementation; agy as fast fallback; codex available for harder cases |
| `plan` | claude, codex | planning and deep analysis |
| `review`, `adversarial-review` | codex, claude, agy | **under-benchmarked** — default to a strong reasoner |
| `mechanical`, `bulk-edit`, `quick-fix` | agy, claude, codex | Gemini Flash speed/cost first; Claude/codex remain available |
| `large-context`, `broad-scan` | agy, codex | Gemini on cost — context-size advantage **unconfirmed** |
| `visual`, `multimodal` | agy | Gemini multimodal strengths |

`recommend --profiles` prints the full matrix.

## Operational reliability (observed in-project)

Benchmarks rank *capability*; delivery reliability through the companion is its own
axis, observed across real review sessions:

- **agy (Gemini)** — a dependable **reviewer** and fast implementer: usually
  first-try, clean structured output, strong planted-bug recall, and now
  write-capable through the companion's patch-harvesting path. `doctor --live`
  remains the guard for no-patch or worktree-escape regressions.
- **codex** — the **specialist ceiling**: catches the deepest architectural
  issues nobody else does, but is **slower** (10+ min on big diffs) and likelier to
  need a retry. Two failure modes the companion now mitigates: (1) *no-output* when a
  long run is killed by too-short a timeout — fixed by the generous default budget +
  timeout/frozen fallback; (2) cosmetic review JSON false-failures — fixed by
  review-output normalization. It is reviewer-only for patches in this runtime.
- **Practical routing:** for high-stakes review, run **both** — agy as the floor,
  codex as the (sometimes-absent) ceiling — rather than relying on codex alone for a
  large diff.

## What stayed unverified (don't route on these)
Adversarial verification **killed** these popular claims — so we do *not* base routing on them:
- Gemini's 1M-token context advantage over Claude/Codex (0-3).
- Per-harness sandboxing/permission models, and Codex `--full-auto`/native CI headless (0-3).
- Exact blog/benchmark percentages that go stale quickly.
- Strict structured-JSON reliability and Flash-tier coding quality — **no** confirmed benchmark,
  so those cells are defaults, not evidence-backed.

## Using it autonomously
The driver classifies the task type (judgment); `recommend` maps it to a worker
(deterministic). Wire it into your project's CLAUDE.md / AGENTS.md — see [`examples/`](../../../examples/).
