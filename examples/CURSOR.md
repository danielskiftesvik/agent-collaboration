<!--
  Example wiring for a project using the agent-collaboration runtime with CURSOR
  as the driver. Paste into a Cursor rule / AGENTS.md / project instructions.
  Set COMPANION to the path of scripts/agent-companion.mjs.

  Prerequisites:
  - Cursor Agent CLI at ~/.cursor/bin/agent (do NOT rely on bare `agent` — that
    may be Grok Build). brew: `brew install --cask cursor-cli` then
    `ln -sfn "$(command -v cursor-agent)" ~/.cursor/bin/agent`.
  - CURSOR_API_KEY or `~/.cursor/bin/agent login` — without this, other drivers
    see `cursor ⚠ interactive-only` and refuse unattended delegate.
  - Confirm with: `node "$COMPANION" setup` → `cursor ✓ worker-ready`.
  - Optional: ~/.agent-collaboration/config.json with a codex-business instance
    (CODEX_HOME=~/.codex-business) if you want reviews on a business Codex home.
-->

## Cross-harness collaboration (autonomous)

Delegate work to the strongest model for each task and gate hard work behind an
independent second opinion. Do this without asking.

> **Driver auto-detects** via `CURSOR_AGENT` / `CURSOR_CONVERSATION_ID`. Pass
> `--driver cursor` / `AGENT_COLLAB_DRIVER=cursor` when you want the native
> short-circuit to be authoritative.

### Route by model strength
```
node "$COMPANION" recommend --task <type> --driver cursor --json
```
Then `node "$COMPANION" delegate --worker <returned> --driver cursor "<brief>"`
(or `review` / `adversarial-review`).

- **Hard reasoning / subtle bugs / adversarial review →** `codex` (or
  `codex-business` instance alias).
- **Careful refactor / planning / general SWE →** `claude` (or native Cursor
  Task when recommend returns `mode: native`).
- **Fast/mechanical/bulk edits, large-context scans →** `agy`.
- Full matrix: `node "$COMPANION" recommend --profiles`.

### Same-harness (native)
If recommend / delegate returns `"mode":"native"`, use Cursor's Task tool /
native subagent — do **not** spawn a cross-harness cursor worker.

### Collaborative-investigation gate
Before non-trivial bugs or design: get a second opinion from another harness
(default preference: codex). Strip your confidence number before sending.

```
node "$COMPANION" recommend --task second-opinion --driver cursor --json
node "$COMPANION" review --worker <returned> --driver cursor "<hypothesis WITHOUT confidence>"
```

**Boundary code:** <LIST THIS PROJECT'S HIGH-RISK AREAS>.
