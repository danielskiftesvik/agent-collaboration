---
description: Get a read-only correctness review from another harness (codex or claude) against the current changes
argument-hint: '--worker <codex|claude> [--focus <text>] <diff / what to review>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Read
---

Request a cross-harness review. Review-only: do not fix issues or apply patches.

Raw arguments:
`$ARGUMENTS`

Prefer **codex** or **claude** as the worker — agy reviews are unreliable (see the
`harness-prompting` skill). Gather the diff (`git diff` / `git diff --cached`) and
pass it as the brief; it becomes the review template's `{{REVIEW_INPUT}}`. Use
`--focus` to weight an area.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" review $ARGUMENTS --driver claude
```

The companion supplies the review template + the worker's JSON output contract.
Present the returned verdict, summary, and findings (ordered by severity) verbatim,
using file paths/line numbers exactly as reported. Then STOP — ask the user which
findings to address before changing anything (see `result-handling`). For an
adversarial "try to break it" pass, use `/agent-collab:adversarial-review`.
