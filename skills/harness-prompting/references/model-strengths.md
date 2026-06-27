# Model strengths & routing

Which underlying model is strongest at what, and how that maps to worker choice. This
mirrors `core/model-profiles.mjs` (the code source of truth for `recommend`).

> **These are general tendencies as of early 2026.** Models change fast — treat this as a
> living guide, weigh task fit over vendor, and edit `core/model-profiles.mjs` as the models
> evolve. Profiles lean on durable traits (context size, speed tiers, model lineage) plus
> what this project verified empirically.

## The three underlying models

### Claude (Anthropic) — careful agentic engineer
- **Stronger at:** sustained multi-step agentic coding; instruction-following & scope
  discipline (less over-reach); refactoring and code taste; implementation planning; clear
  explanation.
- **Weaker at:** raw speed/cost vs Gemini Flash; max context size vs Gemini.

### GPT-5.x / Codex (OpenAI) — reasoner / analyst
- **Stronger at:** hard reasoning & algorithmic problems; math; finding subtle bugs;
  adversarial / critical review; strict structured output (schema-enforceable via its API).
- **Weaker at:** less hand-holding-careful than Claude over long edit sessions; sandbox
  friction when used as a driver.

### Gemini 3.x (Google) — wide-context speedster
- **Stronger at:** very large context window (whole-repo / big-doc ingestion); multimodal
  input (images, PDFs, screens); speed & low cost on the **Flash** tier; broad scans; Google
  Cloud tasks.
- **Weaker at:** strict JSON/format adherence on Flash (we hit this — needed an emphatic
  example-anchored contract); more variable on precise contracts than Claude/GPT.

## Task → worker

Run `agent-companion.mjs recommend --task <type> --driver <self>` — it returns the strongest
*available* worker (excluding the driver) plus the model's profile and a reason. The mapping:

| Task type | Preferred | Why |
|---|---|---|
| `second-opinion` | other of codex/claude | independence + deep reasoning |
| `adversarial-review`, `review` | codex, claude, agy | reliable structured findings |
| `hard-bug`, `architecture`, `design-tradeoff` | codex, claude | reasoning depth |
| `refactor`, `plan`, `general-swe` | claude, codex | careful SWE + planning |
| `mechanical`, `bulk-edit`, `quick-fix` | agy, claude | Gemini Flash speed/cost |
| `large-context`, `broad-scan` | agy, codex | Gemini context window |

`recommend --profiles` prints the full capability matrix.

## How to use it autonomously
The driver classifies the task type (judgment), then `recommend` maps it to a worker
(deterministic). Wire this into your project's CLAUDE.md / AGENTS.md so it runs without
asking — see [`examples/`](../../../examples/).
