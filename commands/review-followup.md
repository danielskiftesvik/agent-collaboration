---
description: Recheck a prior cross-harness review against a focused follow-up change
argument-hint: '--job <prior-job-id> [--worker <name>] [--surface head|working-tree|diff] <focused diff / context>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Read
---

Run a focused re-review tied to an earlier review job. The runtime supplies the prior
structured artifact and tells the reviewer to verify resolved findings and regressions
from this follow-up, without repeating broad discovery.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" review-followup $ARGUMENTS --driver claude
```

Present the returned artifact under the same read-only result-handling rules as a normal review.
