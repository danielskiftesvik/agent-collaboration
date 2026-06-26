---
description: Detect which harnesses (Codex, Antigravity/agy, Claude) can act as cross-harness workers, and optionally toggle the stop-time review gate
argument-hint: '[--gate on|off]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" setup $ARGUMENTS`

Present the table to the user. For each harness explain:
- `✓ worker-ready` — can be delegated to non-interactively.
- `⚠ interactive-only` — installed but would block on prompts; not a valid worker.
- `✗ unavailable` — not installed (or no override env var set).

If the user passed `--gate on|off`, confirm the stop-time review gate's new state.
