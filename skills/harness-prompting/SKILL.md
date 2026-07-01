---
name: harness-prompting
description: How to compose an effective brief for a cross-harness worker or reviewer. Use when delegating a task to codex, agy (Antigravity/Gemini), or claude and you want reliable, well-shaped output.
---

# Harness Prompting

A delegated worker only sees the brief you send. The biggest quality lever is a
**tight prompt contract** — state the task, the exact end state, the
follow-through default, and the few constraints that matter. Prefer a better
contract over telling the model to "think harder."

## Two paths (mirrors how the runtime works)

- **Review-grade work** (`/agent-collab:review`, `/agent-collab:adversarial-review`):
  the companion already supplies a full code-loaded template
  (`prompts/<kind>.md`: `<attack_surface>`, `<grounding_rules>`, …) and fills
  `{{OUTPUT_CONTRACT}}` with the target harness's output contract. You only supply
  the diff/context (the brief → `{{REVIEW_INPUT}}`) and optionally `--focus`.
- **Free-form work** (`/agent-collab:delegate`): YOU compose the brief. Use the
  reusable blocks and the per-harness recipe below.

## Compose a free-form brief

Pick the smallest set of blocks that fits (full catalog:
[references/prompt-blocks.md](references/prompt-blocks.md)):
- **Worker / fix:** `task`, `action_safety`, `completeness_contract`, `verification_loop`.
- **Diagnosis / research:** `task`, `research_mode`, `missing_context_gating`, `citation_rules`.

The companion appends the harness's output contract automatically — don't hand-write it.

## Pick the harness, then read its guide

| Harness | Best for | Guide |
|---|---|---|
| **codex** (GPT-5.x) | reviewer **and** worker; reliable JSON | [references/codex.md](references/codex.md) |
| **claude** | reviewer **and** worker; native `Agent` tool when same-harness | [references/claude.md](references/claude.md) |
| **agy** (Gemini) | reviewer **and** worker; pinned to latest Gemini **Flash** for speed (`AGENT_COLLAB_AGY_CLASS=Pro` for stronger reasoning) | [references/agy.md](references/agy.md) |
| **qwen** (local) | `local-only` sensitive review and `plan-execution` implementation ONLY — always explicit, never in default routing | [references/qwen.md](references/qwen.md) |

Each guide has the model-specific style, copy-paste recipes, and anti-patterns.

## Universal anti-patterns
- Vague framing; no output contract; mixing unrelated jobs in one run.
- Asking for more reasoning instead of a tighter contract.
- Unsupported certainty — require claims grounded in the provided context.
