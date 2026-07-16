---
description: Detect cross-harness workers and configure the review gate, sandbox, or artifact retention
argument-hint: '[--gate on|off] [--sandbox on|off] [--retention-days n]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" setup $ARGUMENTS`

Present the table to the user. For each harness explain:
- `✓ worker-ready` — can be delegated to non-interactively.
- `⚠ interactive-only` — installed but would block on prompts; not a valid worker.
- `✗ unavailable` — not installed (or no override env var set).

Confirm any supplied `--gate`, `--sandbox`, or `--retention-days` setting. Retention is
30 days by default; 0 disables artifact expiry. Unapplied patches remain protected.
