---
description: Cancel an unhealthy collaboration job, or explicitly force cancellation of a healthy one
argument-hint: '<jobId> [--force]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" cancel $ARGUMENTS`

If cancellation succeeded, confirm it. If the runtime refuses because the job is
healthy and within-budget, do not claim it is stalled: present the health state and
continue with the returned wait command. Use `--force` only for an intentional user-
authorized cancellation, never merely because a quiet worker is unfinished. Report whether
the exact job worktree was removed or cleanup was deferred because its process remained live.
