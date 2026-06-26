---
description: Apply a completed worker's patch to the working tree (3-way merge against the recorded base)
argument-hint: '<jobId>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Read
---

Before applying, inspect the patch (`<artifactDir>/patches/<worker>.diff` from `/agent-collab:result` or `/agent-collab:status <jobId>`). Only apply if it matches the intended change.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" apply $ARGUMENTS
```

If the result reports `conflicted`, resolve the conflict markers in the working tree, then continue. If `not applied`, report the error and do not retry blindly.
