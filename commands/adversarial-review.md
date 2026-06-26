---
description: Get an adversarial ("try to break it") review from another harness (codex or claude) against the current changes
argument-hint: '--worker <codex|claude> [--focus <text>] <what to review>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Read
---

Request an adversarial cross-harness review — the worker is told to find the
strongest reasons the change should NOT ship. Review-only: do not fix or apply.

Raw arguments:
`$ARGUMENTS`

Any worker (**codex**, **claude**, or **agy**) can review. Gather the diff to review
(`git diff` / `git diff --cached`) and pass it as the brief; it becomes the
template's `{{REVIEW_INPUT}}`. Use `--focus` to weight an area.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" adversarial-review $ARGUMENTS --driver claude
```

The companion supplies the full adversarial template + the worker's JSON output
contract. Present the returned verdict, summary, and findings (ordered by severity)
verbatim, using file paths/line numbers exactly as reported. Then STOP and ask the
user which findings, if any, to address — do not auto-fix (see `result-handling`).
