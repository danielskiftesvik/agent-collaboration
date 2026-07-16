---
description: Preview or reclaim dead collaboration worktrees and expired artifacts
argument-hint: '[--dry-run] [--artifacts-older-than days] [--include-unapplied] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" gc $ARGUMENTS`

Summarize reclaimed worktrees, artifacts, and bytes. Emphasize that live jobs are always
preserved. Without `--include-unapplied`, old unapplied patch artifacts are preserved too.
Treat `--include-unapplied` as an explicit destructive opt-in.
