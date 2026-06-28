# Model strengths & routing

Which underlying model is strongest at what, and how that maps to worker choice. Mirrors
`core/model-profiles.mjs` (the code source of truth for `recommend`).

> **Two governing caveats — read first.**
> 1. **Harness > model.** The agent harness/scaffolding swings coding benchmarks **10–24
>    points on identical model weights** (Harness-Bench, arXiv:2605.27922; Scale AI). So these
>    are model+**harness** tendencies, and cross-vendor rankings are only valid on
>    *same-scaffold* benchmarks. Undisclosed-harness scores are effectively non-reproducible.
> 2. **Decays monthly.** Frontier models ship ~monthly (Claude Opus 4.5→4.6→4.7→4.8;
>    GPT-5.2→5.4→5.5; Gemini 3.1 Pro). Version-stamped **mid-2026** — edit
>    `core/model-profiles.mjs` as they evolve, and weigh task fit over vendor.

## The three underlying models (mid-2026)

### Claude (Anthropic — Opus 4.7+/Sonnet) — agentic engineer
- **Stronger at:** general SWE & careful refactoring, long-horizon agentic terminal work,
  instruction-following & scope discipline, planning.
- **Evidence:** leads **SWE-bench Verified (87.6%, Opus 4.7, Apr 2026)** and **Terminal-Bench
  2.0 (69.4%)** — the agentic/near-saturated sets. (Verified is near-saturated + largely
  self-reported, so read it as direction, not precision.)
- **Weaker at:** the hardest contamination-resistant set — trails GPT-5.x on standardized
  SWE-bench Pro; raw speed/cost vs Gemini Flash.

### GPT-5.x / Codex (OpenAI — GPT-5.4/5.5) — reasoner / analyst
- **Stronger at:** hardest contamination-resistant debugging & reasoning, algorithms, math,
  subtle bug-finding, adversarial analysis.
- **Evidence:** leads the **standardized SWE-bench Pro** (Scale SEAL same-scaffold public set,
  Jun 9 2026): GPT-5.4 xHigh **59.1%** > Claude Opus 4.6 thinking 51.9% > Gemini 3.1 Pro
  thinking 46.1%. This is the fairest cross-vendor comparison (one identical scaffold).
- **Weaker at:** trails the latest Claude on the near-saturated Verified / Terminal-Bench
  agentic sets; sandbox friction when used as a driver.

### Gemini 3.x (Google — 3.1 Pro / Flash) — fast & wide, but trails on coding benchmarks
- **Stronger at:** speed & low cost (Flash tier) for high-throughput edits; multimodal input;
  large context windows for whole-repo work.
- **Weaker at:** currently **trails Claude/GPT-5.x on confirmed coding benchmarks** (~7–8 pts
  behind on SWE-bench Verified at 80.6%; bottom of the standardized Pro cluster, within error
  bars of Opus 4.5/Sonnet 4.5); strict JSON adherence on Flash (verified in this project).
- **Refuted:** the often-cited **1M-token context *advantage* over Claude/Codex did NOT survive
  adversarial verification** (0-3) — Gemini has large context, but "bigger than rivals" is
  unconfirmed mid-2026.

## Task → worker

`agent-companion.mjs recommend --task <type> --driver <self>` returns the strongest *available*
worker (excluding the driver) + the model's profile + a reason. The mapping:

| Task type | Preferred | Basis |
|---|---|---|
| `second-opinion` | other of codex/claude | independence + deep reasoning |
| `hard-bug`, `architecture`, `design-tradeoff` | codex, claude | GPT-5.x leads standardized SWE-bench Pro |
| `refactor`, `plan`, `general-swe` | claude, codex | Claude leads SWE-bench Verified + Terminal-Bench 2.0 |
| `review`, `adversarial-review` | codex, claude, agy | **under-benchmarked** — default to a strong reasoner |
| `mechanical`, `bulk-edit`, `quick-fix` | agy, claude | Gemini Flash speed/cost — **not** benchmark-confirmed |
| `large-context`, `broad-scan` | agy, codex | Gemini on cost — context-size advantage **unconfirmed** |

`recommend --profiles` prints the full matrix.

## Operational reliability (observed in-project, mid-2026)

Benchmarks rank *capability*; delivery reliability through the companion is its own
axis, observed across real review sessions:

- **agy (Gemini)** — a dependable **reviewer**: fast (~1 min), usually first-try, clean
  structured output, strong planted-bug recall. **Reviewer-only as a delegated worker**,
  though: agy (1.0.13) ignores the worktree it's handed and writes to its own
  `~/.gemini/.../scratch/`, so a delegated *write* task captures an empty patch
  (`no-changes`). `recommend` routes writes to codex/claude accordingly.
- **codex (GPT-5.x)** — the **specialist ceiling**: catches the deepest architectural
  issues nobody else does, but is **slower** (10+ min on big diffs) and likelier to
  need a retry. Two failure modes the companion now mitigates: (1) *no-output* when a
  long run is killed by too-short a timeout — fixed by the generous default budget +
  timeout→fallback; (2) *severity-case false-failure* (emits `"High"`) — fixed by
  review-output normalization.
- **Practical routing:** for high-stakes review, run **both** — agy as the floor,
  codex as the (sometimes-absent) ceiling — rather than relying on codex alone for a
  large diff.

## What stayed unverified (don't route on these)
Adversarial verification **killed** these popular claims — so we do *not* base routing on them:
- Gemini's 1M-token context advantage over Claude/Codex (0-3).
- Per-harness sandboxing/permission models, and Codex `--full-auto`/native CI headless (0-3).
- Several blog SWE-bench/Terminal-Bench/Aider/LiveCodeBench numbers (refuted in favor of the
  same-scaffold Scale SEAL set and primary vendor announcements).
- Strict structured-JSON reliability and Flash-tier coding quality — **no** confirmed benchmark,
  so those cells are defaults, not evidence-backed.

## Using it autonomously
The driver classifies the task type (judgment); `recommend` maps it to a worker
(deterministic). Wire it into your project's CLAUDE.md / AGENTS.md — see [`examples/`](../../../examples/).
