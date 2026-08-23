# Prompting dsh (DeepSeek Harness)

**DeepSeek Harness** is DeepSeek's agent CLI (`dsh`). Headless workers run
`dsh --profile headless`. It follows the same [prompt-blocks.md](prompt-blocks.md)
as the other CLIs.

- **Always explicit** — never auto-selected by `recommend`. Pass `--worker dsh`.
- **Good as both reviewer and worker.** The companion appends `{{OUTPUT_CONTRACT}}`.
- **Headless cannot prompt.** Workers and reviewers spawn with
  `DSH_PERMISSION_MODE=danger-full-access`. Write safety is the isolated worktree
  + breach detection, not a permission sandbox. There is no grok-style `plan` mode.
- **Same-harness shortcut:** when the *driver is dsh*, do not delegate to dsh
  through the companion — use DeepSeek Harness's native subagent instead (`/ac`
  will return `mode: native`).
- Default model is whatever you configured in the dsh UI (often a DeepSeek V4
  Flash-class endpoint). Pin via `.agent-collab.json` / `AGENT_COLLAB_DSH_MODEL`
  for our records; the CLI currently inherits `~/.dsh/settings.yaml`.

## Env / pins

| Lever | Effect |
|---|---|
| `AGENT_COLLAB_DSH_BIN` | Override the `dsh` binary |
| `AGENT_COLLAB_DSH_MODEL` | Resolved-model pin recorded on the spawn |
| `AGENT_COLLAB_DSH_MODEL_REVIEW` | Reviewer-only; generic `_MODEL` wins |
| `.agent-collab.json` `workers.dsh` | Standing pin |

Install: put `dsh` on `PATH`. Driver plugin:

```bash
dsh plugin --profile web add github:danielskiftesvik/agent-collaboration
```

Full guide: [`docs/README.dsh.md`](../../../docs/README.dsh.md).

## Recipes

### Fix (worker)
```xml
<task>Make the smallest correct change for: <goal>. Preserve behavior elsewhere.</task>
<action_safety>Keep the change scoped to the goal; no unrelated refactors.</action_safety>
<verification_loop>Re-check the change against the goal before finishing; run available checks.</verification_loop>
```

### Review (reviewer)
Use the `review` / `adversarial-review` verbs. Put the diff in the brief. Do not
edit files.

## Anti-patterns
- Delegating dsh→dsh through the companion instead of the native subagent.
- Expecting auto-selection from `recommend`.
- Assuming headless reviewers are OS-enforced read-only — they are not.
