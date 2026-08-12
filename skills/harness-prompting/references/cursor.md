# Prompting cursor (Cursor Agent CLI as worker/reviewer)

Cursor's headless Agent CLI (`~/.cursor/bin/agent`, never bare `agent`) follows
clear structured briefs well — similar to Claude. Use the same
[prompt-blocks.md](prompt-blocks.md). Default model pin: `composer-2.5`
(`AGENT_COLLAB_CURSOR_MODEL` / `_MODEL_REVIEW` / `.agent-collab.json` pins).

- **Good at both reviewer and worker.** Companion fills `{{OUTPUT_CONTRACT}}`
  with a concise `<output_contract>` block (same shape as Claude).
  Auto-`recommend` uses Cursor for SWE/refactor/plan/mechanical routes;
  review and second-opinion stay on calibrated reasoners until Cursor's
  reviewer model is pinned — pass `--worker cursor` explicitly for reviews.
- **Reviewer is read-only** (`--mode ask`, no `--force`). **Worker edits**
  (`--force`) inside the companion worktree (`--workspace`; never Cursor's
  `--worktree` — the companion already isolates).
- **Same-harness shortcut:** when the *driver is Cursor*, do NOT delegate to
  `cursor` through the companion — use Cursor's Task / native subagent. The
  companion returns `mode: "native"`.
- **Auth:** `CURSOR_API_KEY` or `~/.cursor/bin/agent login`. `setup` /
  `unattendedProbe` fails closed when neither is present.
- **Binary collision:** on machines that also have Grok Build, bare `agent` is
  often Grok. Always pin `AGENT_COLLAB_CURSOR_BIN=~/.cursor/bin/agent` (or rely
  on the adapter's resolution order, which never falls back to bare `agent`).

## Install (safe alongside Grok)

```bash
# Official installer overwrites ~/.local/bin/agent — prefer a companion-safe layout:
curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh
# Or download the versioned package and link only under ~/.cursor/bin:
#   ~/.cursor/bin/agent → ~/.local/share/cursor-agent/versions/<ver>/cursor-agent
# Keep ~/.local/bin/agent pointing at Grok if that is what you want.
~/.cursor/bin/agent login   # or export CURSOR_API_KEY=…
```

## Recipes

### Fix (worker)
```xml
<task>Make the smallest correct change for: <goal>. Preserve behavior elsewhere.</task>
<action_safety>Keep the change scoped to the goal; no unrelated refactors.</action_safety>
<verification_loop>Re-check the change against the goal before finishing; run available checks.</verification_loop>
```

### Review (reviewer)
Use the `review` / `adversarial-review` verbs — the companion supplies the full
template + JSON `<output_contract>`. Put the diff/context in the brief; pass
`--focus` to weight an area.

## Anti-patterns
- Spawning bare `agent` (may be Grok Build on PATH).
- Nesting Cursor `--worktree` on top of the companion worktree.
- Delegating cursor→cursor through the companion instead of the native Task tool.
- Asking a reviewer to also fix — keep review and edit as separate, gated steps.
