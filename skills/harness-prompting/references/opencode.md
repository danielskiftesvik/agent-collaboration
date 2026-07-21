# Prompting opencode (OpenCode as worker/reviewer)

opencode is a multi-provider harness (Anthropic, OpenAI, Google, DeepSeek,
local, etc.) — the underlying model is chosen per dispatch via env var or pin. It
follows clear structured instructions well; the same
[prompt-blocks.md](prompt-blocks.md) still apply.

- **Good at both reviewer and worker.** The companion fills `{{OUTPUT_CONTRACT}}`
  with a concise `<output_contract>` block.
- **Reviewer gets `--auto`** — no per-role tool exclusion on the CLI. Write safety
  is via worktree isolation + breach detection.
- **No thread-resume mechanism** — retry is always a full re-send (side effects
  may repeat). Use `--background` when the driver shell can't hold a long
  synchronous command.
- **Always explicit.** OpenCode is never auto-selected by `recommend`; you must
  name it explicitly (`--worker opencode`).

## Model selection

Model is in `provider/model` format (e.g. `anthropic/claude-sonnet-4-20250514`):

| Env var | Purpose |
|---|---|
| `AGENT_COLLAB_OPENCODE_MODEL` | Per-dispatch model override |
| `AGENT_COLLAB_OPENCODE_MODEL_REVIEW` | Reviewer-only model; generic `_MODEL` wins if both set |
| `AGENT_COLLAB_OPENCODE_BIN` | Override the `opencode` binary path |

Or pin standing models in `.agent-collab.json`:

```json
{
  "workers": {
    "opencode": { "reviewer": { "model": "anthropic/claude-sonnet-4-20250514" } }
  }
}
```

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
- Assuming opencode will be auto-recommended — it won't; name it explicitly.
- Long unstructured prose that buries the actual task and end state.
- Omitting the output contract when you need a structured result.
- Asking a reviewer to also fix — keep review and edit as separate, gated steps.
- Forgetting that retry is always a full re-send (no thread resume) — side effects repeat.
