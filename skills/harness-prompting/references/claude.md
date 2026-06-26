# Prompting claude (Claude Code as worker/reviewer)

Claude follows clear, structured natural-language instructions well — it does not
need agy's emphatic example-anchoring or codex's terse operator tone, but the same
[prompt-blocks.md](prompt-blocks.md) still apply. State the task, the end state, and
a concise output contract.

- **Good at both reviewer and worker**, and reliable at JSON when asked. The
  companion fills `{{OUTPUT_CONTRACT}}` with a concise `<output_contract>` block.
- **Reviewer runs read-only** (`--permission-mode plan`); **worker can edit**
  (`acceptEdits`) inside its worktree.
- **Same-harness shortcut:** when the *driver is Claude Code*, do NOT delegate to
  claude through the companion — use the native `Agent` tool (a subagent). The
  companion returns `mode: "native"` and the instruction to do so.
- Claude benefits from explicit scope and stop conditions; lead with the goal,
  then constraints. Avoid burying the task under long preamble.

## Recipes

### Fix (worker)
```xml
<task>Make the smallest correct change for: <goal>. Preserve behavior elsewhere.</task>
<action_safety>Keep the change scoped to the goal; no unrelated refactors.</action_safety>
<verification_loop>Re-check the change against the goal before finishing; run available checks.</verification_loop>
```
The companion appends the worker output contract (`{status, summary, changed}`);
the patch is the real deliverable.

### Review (reviewer)
Use the `review` / `adversarial-review` verbs — the companion supplies the full
template (`<attack_surface>`, `<grounding_rules>`, …) + a JSON `<output_contract>`.
Put the diff/context in the brief (it becomes `{{REVIEW_INPUT}}`); pass `--focus`
to weight an area.

### Diagnose
```xml
<task>Diagnose the root cause of <symptom>. Use the repo + tools.</task>
<compact_output_contract>Root cause, evidence, smallest safe next step.</compact_output_contract>
<missing_context_gating>Don't guess; state what's unknown.</missing_context_gating>
```

## Anti-patterns
- Delegating claude→claude through the companion instead of the native `Agent` tool.
- Long unstructured prose that buries the actual task and end state.
- Omitting the output contract when you need a structured result.
- Asking a reviewer to also fix — keep review and edit as separate, gated steps.
