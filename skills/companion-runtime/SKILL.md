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
delegate --worker <agy|codex|claude> [--driver <name>] [--role worker|reviewer] [--apply] [--timeout <s>] [--no-fallback] <brief>
review  --worker <name> [--focus <text>] [--no-fallback] [--json] <diff/context>
adversarial-review --worker <name> [--focus <text>] [--no-fallback] [--json] <diff/context>
status [jobId] [--json]
result <jobId> [--json]
apply  <jobId>
cancel <jobId>
```

## Routing (decide before spawning)

- `delegate` returns `{"mode":"native", instruction}` when `driver === worker`
  **and the driver is authoritatively known**. In that case do NOT use the
  companion — follow the instruction (use the harness's native subagent; for
  Claude Code that's the `Agent` tool).
- Otherwise it runs the cross-harness path (worktree → spawn → collect).

### Who is the driver? (avoid the native no-op footgun)

The driver is resolved in this order — only the first two are **authoritative**
and may trigger the native path:

1. `--driver <name>` flag (authoritative)
2. `AGENT_COLLAB_DRIVER` env (authoritative)
3. env auto-detection (label only)
4. `claude` fallback (label only)

Native short-circuiting requires an *authoritative* driver on purpose: when you
drive from **Codex or agy over the raw shell** and forget `--driver`, the driver
would otherwise default to `claude`, so `--worker claude` would look like
`driver === worker` and return a "use your own subagent" no-op **instead of
actually delegating**. So a guessed driver always takes the cross-harness path.

Auto-detection status (mid-2026, verified from live sessions):
- **Codex** — auto-detected via `CODEX_THREAD_ID` (every session) / `CODEX_MANAGED_*`.
  No setup needed.
- **Claude Code** — detected via `CLAUDECODE`/`CLAUDE_PLUGIN_ROOT`; and its slash
  commands pass `--driver claude` anyway.
- **agy** — **NOT auto-detectable** (a live agy session sets no
  agy/antigravity/gemini env var). agy drivers **must** set
  `AGENT_COLLAB_DRIVER=agy` for correct labeling (the example `AGENTS.md` does).
  The footgun still can't bite — a non-authoritative driver never goes native —
  but without it agy is mislabeled `claude`, which skews fallback-candidate
  exclusion and `recommend`.

## Roles & kinds

- `delegate` default role = `worker`; `review`/`adversarial-review` = `reviewer`.
- `review`/`adversarial-review` build the prompt from `prompts/<kind>.md`
  (template path). `delegate` sends the caller's brief + the harness output
  contract (free-form path — compose with the `harness-prompting` skill).

## --json result fields

`{ jobId, worker, status (completed|conflicted|failed|blocked), resultValid,
changed, patchApplies, artifact, artifactDir, patchPath, errors }`. A worker is
`completed` on a clean non-empty patch even if `resultValid` is false (the patch
is the deliverable). Apply a worker patch only via `apply` / `--apply`, after
inspection. `worker` is the harness that actually ran (may differ from the one you
asked for — see auto-fallback).

On a **failed** run, two more fields explain why: `failureKind`
(`rate-limit` | `auth` | `timeout` | `other`) and `resetAt` (best-effort reset
hint for a limit). See the `result-handling` skill for how to present these.

## Auto-fallback on limits & timeouts

`delegate`/`review`/`adversarial-review` auto-fall-back to the next worker-ready
harness when the chosen worker hits a **subscription/rate limit, auth, or
timeout** failure (an `other` failure never triggers it). The result then carries
`note` (a human sentence), `fellBackFrom[]` (`{worker, failureKind, resetAt}`),
and — if every worker failed that way — `allWorkersLimited: true`. Fallback only
ever moves to another **worker** harness; it never silently makes the driver do
the task. Disable with `--no-fallback` or `AGENT_COLLAB_FALLBACK=off`.

## Timeouts (avoid the "no JSON found" no-output)

A deep reasoner (codex) on a large diff can run 10+ minutes and prints its JSON
only at the END — so a short timeout SIGTERMs it mid-run and you get an empty,
unparseable result. The default per-attempt budget is therefore **generous (20
min)**; raise/lower it with `--timeout <s>` or `AGENT_COLLAB_TIMEOUT=<s>`. A
timeout is **not** retried in place (re-sending the same slow prompt just times
out again) — it surfaces as `failureKind: "timeout"` and auto-falls-back to a
faster worker.

## Repair by resume (codex)

When a worker's first reply isn't valid (non-timeout), the repair attempt
**continues the worker's existing thread** rather than re-running the task cold —
for codex that's `task --resume-last` with a short "emit clean JSON" ask, so the
loaded diff/context isn't paid for twice. If the thread can't be resumed it
automatically falls back to a fresh full re-send (so resume can never regress).
Disable with `AGENT_COLLAB_CODEX_RESUME=off`.

## Review-output normalization

Reviewer JSON is normalized before validation so a complete report isn't
false-failed over cosmetics: `severity`/`verdict` are lowercased/trimmed (codex
often emits `"High"`), common severity synonyms are mapped, and `next_steps` is
optional. The deliverable is still the report — if a job ever shows `failed`,
read `tasks/<jobId>/reports/<worker>.md` before concluding nothing came back.

## Env

- `AGENT_COLLAB_DATA` — out-of-repo state root (default: tmp/plugin-data).
- `AGENT_COLLAB_DRIVER` — default driver harness.
- `AGENT_COLLAB_SANDBOX=on` — opt-in OS sandbox (off by default).
- `AGENT_COLLAB_FALLBACK=off` — disable auto-fallback on a limit/timeout (on by default).
- `AGENT_COLLAB_TIMEOUT=<s>` — per-attempt worker timeout in seconds (default 1200 = 20 min).
- `AGENT_COLLAB_CODEX_RESUME=off` — repair with a fresh re-send instead of resuming the codex thread (resume is on by default).
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
