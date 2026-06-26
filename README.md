# agent-collaboration

Cross-harness agent collaboration. A driver harness (Claude Code, Codex, or
Antigravity) can delegate a task to a **worker** or **reviewer** running on
another harness, then apply the result to the main branch.

This is a generalization of OpenAI's Apache-2.0 `codex-plugin-cc` (see `NOTICE`):
its single CC→Codex direction is widened into a harness-agnostic core plus
per-harness adapters.

## Two delegation paths

- **Native path (same harness):** when driver and worker are the same harness,
  use that harness's own subagent primitive (Claude Code `Agent` tool,
  Antigravity `invoke_subagent`, Codex's native subagent). No worktree, no
  shell adapter, no companion job.
- **Cross-harness path:** when driver ≠ worker, the `agent-companion` runtime
  creates an isolated workspace, writes a brief, spawns the target harness in
  **strict unattended mode**, monitors via heartbeat, and collects artifacts.
  The driver — and only the driver — applies the resulting patch.

## Layout

| Path | Purpose |
|---|---|
| `scripts/agent-companion.mjs` | CLI entry / dispatch (generalized `codex-companion.mjs`) |
| `core/` | harness-agnostic state, jobs, workspace, heartbeat, render, git, schema |
| `adapters/` | per-harness worker adapters (`claude`, `codex`, `agy`) |
| `schemas/` | JSON artifact contracts (`result`, `review-output`) |
| `commands/`, `hooks/`, `skills/`, `.claude-plugin/` | Claude Code driver surface |

State is stored **outside** the repo (keyed by a hash of the workspace root) so
it survives git worktrees and is never committed.

## Status

v0.1 — Claude Code as driver, reusing the installed Codex path and adding an
Antigravity (`agy`) worker/reviewer adapter. Reverse-driver plugins and GUI
integration are out of scope for v1.
