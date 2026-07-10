---
description: Show the artifact produced by a job id or recover the latest matching job
argument-hint: '<jobId|--latest> [--worker name] [--role role]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" result $ARGUMENTS`

Present the worker's report and structured output to the user. `--latest` selects by creation time and can be narrowed by worker/role. Do not summarize away the findings or change recommendations.
