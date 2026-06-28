---
description: Self-check the collaboration runtime — config + worker readiness, and (with --live) a review-cycle + worktree-isolation smoke test per worker against a throwaway repo
argument-hint: '[--live] [--workers agy,codex,claude]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" doctor $ARGUMENTS`

Present the check table. Each line is `✓`/`✗ <name> — <detail>`:
- `node>=20`, `state-dir-writable`, `workers-ready` — environment/config health.
- With `--live`: `review:<worker>` (the worker returned a valid schema'd review) and
  `isolation:<worker>` (the worker stayed in its worktree — an escape is a **breach**).

If any check fails, surface it plainly. A failing `isolation:*` is a containment
breach — call it out and recommend not using that worker as an implementer until
fixed. Note that `--live` spends real model usage, and the isolation check validates
transport + containment against a throwaway repo (not every possible escape condition).
