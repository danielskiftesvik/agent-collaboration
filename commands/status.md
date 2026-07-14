---
description: Read cross-harness job metadata or recover the latest matching job; refresh liveness only when requested
argument-hint: '[jobId|--latest] [--worker name] [--role role] [--refresh|--wait] [--timeout s] [--active] [--recent n]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" status $ARGUMENTS`

If no job id or `--latest` was passed, render the output as a compact Markdown table. Otherwise present the selected job's full detail, including `health`. Plain reads do not acquire the state lock; use `--refresh` to persist objective liveness changes or `--wait` to block. A live within-budget job is not stalled even when terminal output is quiet. Do not add commentary.
