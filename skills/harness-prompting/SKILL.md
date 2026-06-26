---
name: harness-prompting
description: How to compose an effective brief for a cross-harness worker or reviewer. Use when delegating a task to codex, agy (Antigravity/Gemini), or claude and you want reliable, well-shaped output.
---

# Harness Prompting

A delegated worker only sees the brief you send. The single biggest quality
lever is a **tight prompt contract** — state the task, the exact output shape,
the follow-through default, and the few constraints that matter. Prefer a better
contract over asking the model to "think harder."

The companion already appends a per-harness output contract (see each adapter's
`outputContract`). This skill is for shaping the *task* half of the brief.

## Core rules

- One clear task per run. Split unrelated asks into separate delegations.
- Say what "done" looks like — don't assume the worker infers the end state.
- For anything where a wrong guess is costly, add explicit grounding/verification.
- Keep it compact and block-structured. Remove redundant instructions.

Reusable blocks (wrap each in its XML tag) live in
[references/prompt-blocks.md](references/prompt-blocks.md). Pick the smallest set
that fits:
- **Worker / fix:** `task`, `action_safety`, `completeness_contract`, `verification_loop`.
- **Reviewer:** `task`, `grounding_rules`, `dig_deeper_nudge` (structured output is added by the adapter).
- **Diagnosis / research:** `task`, `research_mode`, `missing_context_gating`.

## Per-harness cheat-sheet

### codex (GPT-5.x)
- Responds best to **XML-tagged, block-structured** prompts in an operator tone.
- Reliable at strict JSON output. Good for **both reviewer and worker**.
- Use `task --resume-last` semantics for follow-ups (send only the delta).

### agy (Antigravity / Gemini)
- **Strong worker, weak at strict structured output** — especially Gemini Flash,
  which tends to reply in prose. Prefer agy for **worker** tasks (the patch is
  the deliverable, not JSON).
- If you need structured output from agy, the adapter already sends an emphatic
  example-anchored "JSON only, nothing else" contract; consider a Pro-tier model
  for structured/reviewer work.
- Runs with `--dangerously-skip-permissions`; **always isolated in a worktree**.
  Never rely on it honoring "review-only" by instruction alone.

### claude (Claude Code)
- Follows clear structured instructions well. Reviewer runs read-only via
  `--permission-mode plan`; worker edits via `acceptEdits`.
- When the driver *is* Claude Code, don't delegate to claude — use the native
  `Agent` tool instead (the companion returns `mode: native`).

## Anti-patterns

- Vague framing ("take a look and let me know"). State the concrete job + end state.
- No output contract ("investigate and report back").
- Mixing unrelated jobs into one run.
- Asking for more reasoning instead of a tighter contract.
- Unsupported certainty — require claims to be grounded in the provided context.
