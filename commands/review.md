---
description: Get a read-only code review from another harness (Codex or Antigravity) against the current changes
argument-hint: '--worker <agy|codex|claude> <focus / what to review>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Read
---

Request a cross-harness review. This is review-only: do not fix issues or apply patches.

Raw arguments:
`$ARGUMENTS`

Gather the diff to review (e.g. `git diff` / `git diff --cached`) and include the relevant context in the brief, then run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" review $ARGUMENTS --driver claude
```

Present the returned review artifact (verdict, summary, findings ordered by severity, next steps) verbatim. Use the file paths and line numbers exactly as reported. Do not make changes in response to the review unless the user asks.
