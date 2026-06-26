---
description: Delegate a write task to a worker on another harness (Codex or Antigravity), producing a patch the driver can apply
argument-hint: '--worker <agy|codex|claude> [--role worker|reviewer] [--apply] [--timeout <seconds>] <brief>'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*), Read
---

Delegate the task described in the arguments to the chosen worker harness.

Raw arguments:
`$ARGUMENTS`

Authority model (do not violate):
- The worker runs in an isolated git worktree and only PRODUCES artifacts (a patch, a report, a result JSON). It never touches the main branch.
- Only the driver (you) applies changes, via `apply` or `--apply`.

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" delegate $ARGUMENTS --driver claude
```

Then:
- If the output has `"mode": "native"`, the requested worker is this same harness. Do NOT use the companion — instead spawn a native Claude Code subagent (the `Agent` tool) to do the work, as the instruction says.
- Otherwise, report the returned `status`, `jobId`, and `artifactDir`. If `valid` is false, show the `errors` and do not apply.
- To apply a successful worker patch to the working tree, run `/agent-collab:apply <jobId>` (or re-run with `--apply`). Review the patch first.
