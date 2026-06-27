---
name: companion-runtime
description: Internal contract for invoking the agent-collaboration companion runtime (agent-companion.mjs). Use when a driver or subagent needs to construct companion CLI calls.
user-invocable: false
---

# Companion Runtime

The single shared runtime is `${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs`.
There is one runtime, not one per harness — per-harness CLI construction lives in
`adapters/<harness>.mjs` (`buildCommand`), not here. This contract is the faithful
generalization of codex-plugin-cc's `codex-cli-runtime` skill.

## Subcommands

```
setup [--json] [--gate on|off] [--sandbox on|off]
delegate --worker <agy|codex|claude> [--driver <name>] [--role worker|reviewer] [--apply] [--timeout <s>] <brief>
review  --worker <name> [--focus <text>] [--json] <diff/context>
adversarial-review --worker <name> [--focus <text>] [--json] <diff/context>
status [jobId] [--json]
result <jobId> [--json]
apply  <jobId>
cancel <jobId>
```

## Routing (decide before spawning)

- `delegate` returns `{"mode":"native", instruction}` when `driver === worker`.
  In that case do NOT use the companion — follow the instruction (use the
  harness's native subagent; for Claude Code that's the `Agent` tool).
- Otherwise it runs the cross-harness path (worktree → spawn → collect).

## Roles & kinds

- `delegate` default role = `worker`; `review`/`adversarial-review` = `reviewer`.
- `review`/`adversarial-review` build the prompt from `prompts/<kind>.md`
  (template path). `delegate` sends the caller's brief + the harness output
  contract (free-form path — compose with the `harness-prompting` skill).

## --json result fields

`{ jobId, status (completed|conflicted|failed|blocked), resultValid, changed,
patchApplies, artifact, artifactDir, patchPath, errors }`. A worker is `completed`
on a clean non-empty patch even if `resultValid` is false (the patch is the
deliverable). Apply a worker patch only via `apply` / `--apply`, after inspection.

## Env

- `AGENT_COLLAB_DATA` — out-of-repo state root (default: tmp/plugin-data).
- `AGENT_COLLAB_DRIVER` — default driver harness.
- `AGENT_COLLAB_SANDBOX=on` — opt-in OS sandbox (off by default).
- `AGENT_COLLAB_<AGY|CLAUDE|CODEX>_BIN` — override a harness binary.
- `AGENT_COLLAB_AGY_MODEL[_PRO|_FLASH]` — explicit agy model id (default: unset).

## Driving from a sandboxed harness

A cross-harness delegation **spawns another agent that makes a network call** (to the
worker's model API) and creates a git worktree. If the driver harness sandboxes shell
commands by default (e.g. **Codex**), the first run comes back empty ("no worker JSON")
because the sandbox blocks the spawn/network. Run the companion with **escalated /
network-enabled permissions** (Codex will offer to escalate; or pre-approve
`node …/agent-companion.mjs` in the harness config). Harnesses that already run
unattended (e.g. `agy --dangerously-skip-permissions`) don't need this. This is
expected: a sandbox *should* gate "spawn a process that calls the internet."

## Rules

- One job per invocation. Don't fabricate results if a run fails — surface stderr.
- The driver holds main-branch authority; workers only produce artifacts.
