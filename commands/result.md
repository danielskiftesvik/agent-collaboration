---
description: Show the artifact (report + structured output) produced by a collaboration job
argument-hint: '<jobId>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" result $ARGUMENTS`

Present the worker's report and structured output to the user. Do not summarize away the findings or change recommendations.
