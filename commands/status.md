---
description: Show recent cross-harness collaboration jobs for this workspace
argument-hint: '[jobId]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" status $ARGUMENTS`

If no job id was passed, render the output as a compact Markdown table. If a job id was passed, present its full detail. Do not add commentary.
