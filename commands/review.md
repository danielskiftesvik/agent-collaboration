---
description: Get a read-only correctness review from another harness against an explicit change surface
argument-hint: '--worker <codex|claude|agy> [--surface head|working-tree|diff] [--focus <text>] <diff / what to review>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Read
---

Request a cross-harness review. Review-only: do not fix issues or apply patches.

Raw arguments:
`$ARGUMENTS`

Any worker (**codex**, **claude**, or **agy**) can review — agy uses its
configured Gemini model (Flash by default). Gather the diff (`git diff` / `git diff --cached`) and pass
it as the brief; it becomes the review template's `{{REVIEW_INPUT}}`. Use `--focus`
to weight an area.

Unified diffs select the `diff` surface automatically. A clean prose brief defaults to `head`;
if the checkout is dirty, explicitly choose `--surface working-tree` to snapshot it or
`--surface head` to exclude those changes. Ambiguous dirty reviews fail closed.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" review $ARGUMENTS --driver claude
```

The companion supplies the review template + the worker's JSON output contract.
Present the returned verdict, summary, and findings (ordered by severity) verbatim,
using file paths/line numbers exactly as reported. Then STOP — ask the user which
findings to address before changing anything (see `result-handling`). For an
adversarial "try to break it" pass, use `/agent-collab:adversarial-review`.
