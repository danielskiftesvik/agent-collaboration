---
description: Cancel a running collaboration job and mark it cancelled
argument-hint: '<jobId>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" cancel $ARGUMENTS`

Confirm to the user that the job was cancelled.
