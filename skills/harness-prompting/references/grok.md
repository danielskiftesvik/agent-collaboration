# Prompting grok (Grok Build as worker/reviewer)

**Grok Build** is xAI's terminal agent harness (binary: `grok`). It follows clear,
structured natural-language instructions similarly to Claude. It has a simple, fast
CLI with streaming JSON output and a broad general-purpose default model (`grok-4.5`;
also `grok-build`). The same [prompt-blocks.md](prompt-blocks.md) apply.

- **Always explicit** — never auto-selected by `recommend`. Pass `--worker grok`.
- **Good at both reviewer and worker**, and produces reliable JSON when asked. The
  companion fills `{{OUTPUT_CONTRACT}}` with a concise `<output_contract>` block.
- **Reviewer runs read-only** (`--permission-mode plan`); **worker can edit**
  (`acceptEdits`) inside its worktree.
- **Same-harness shortcut:** when the *driver is Grok Build*, do NOT delegate to
  grok through the companion — use Grok Build's native subagent capabilities instead.
- Free-tier Grok Build usage limits apply; rate-limit failures auto-fall back when
  another worker is available.

## Env / pins

| Lever | Effect |
|---|---|
| `AGENT_COLLAB_GROK_BIN` | Override the `grok` binary |
| `AGENT_COLLAB_GROK_MODEL` | Model id (default `grok-4.5`; also `grok-build`) |
| `AGENT_COLLAB_GROK_MODEL_REVIEW` | Reviewer-only model; generic `_MODEL` wins |
| `AGENT_COLLAB_GROK_EFFORT` | Reasoning effort (`none`…`max` → `--effort`) |
| `.agent-collab.json` `workers.grok` | Standing pin for model/effort |

Install CLI: `curl -fsSL https://x.ai/cli/install.sh | bash` — state lives under `~/.grok`.  
Plugin: `grok plugin install https://github.com/danielskiftesvik/agent-collaboration --trust`  
(then `grok plugin update agent-collaboration`). Full guide: [`docs/README.grok.md`](../../../docs/README.grok.md).

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
- Delegating grok→grok through the companion instead of Grok Build's native subagent.
- Long unstructured prose that buries the actual task and end state.
- Omitting the output contract when you need a structured result.
- Asking a reviewer to also fix — keep review and edit as separate, gated steps.
- Expecting auto-selection from `recommend` — Grok Build is always opt-in via `--worker grok`.
