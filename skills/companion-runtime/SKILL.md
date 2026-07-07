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
doctor [--live] [--workers a,b] [--json]
delegate --worker <agy|codex|claude> [--driver <name>] [--role worker|reviewer] [--background] [--apply] [--timeout <s>] [--no-fallback] <brief>
review  --worker <name> [--focus <text>] [--background] [--no-fallback] [--json] <diff/context>
adversarial-review --worker <name> [--focus <text>] [--background] [--no-fallback] [--json] <diff/context>
status [jobId] [--wait] [--timeout <s>] [--json]
result <jobId> [--json]
apply  <jobId>
cancel <jobId>
```
(`run-job --job <id>` exists but is INTERNAL — it's the detached worker entrypoint
spawned by `--background`; don't call it directly.)

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

Auto-detection status (verified from live sessions) — all three now
auto-detect, so `--driver`/`AGENT_COLLAB_DRIVER` is only an override:
- **Codex** — `CODEX_THREAD_ID` (every session) / `CODEX_MANAGED_*`.
- **agy** — `ANTIGRAVITY_AGENT` / `ANTIGRAVITY_CONVERSATION_ID` / `ANTIGRAVITY_PROJECT_ID`.
- **Claude Code** — `CLAUDECODE` / `CLAUDE_PLUGIN_ROOT` (its slash commands also pass
  `--driver claude`). Checked last, so an actively-running Codex/agy beats an
  inherited Claude env.

## Roles & kinds

- `delegate` default role = `worker`; `review`/`adversarial-review` = `reviewer`.
- `review`/`adversarial-review` build the prompt from `prompts/<kind>.md`
  (template path). `delegate` sends the caller's brief + the harness output
  contract (free-form path — compose with the `harness-prompting` skill).

## --json result fields

`{ jobId, worker, status, resultValid, changed, patchApplies, attempts, artifact,
artifactDir, patchPath, breach, escapedPaths, breachWarning, report, errors }`. `status` is one of
`completed | no-changes | conflicted | breach | blocked | failed`. A worker is
`completed` on a clean non-empty patch even if `resultValid` is false (the patch
is the deliverable); a valid self-report with **no** patch is `no-changes`, never
`completed`. `breach: true` (+ `escapedPaths`) means the worker wrote into the
driver's real checkout — surface it, don't apply. `breachWarning` means the real
checkout changed during the run but the clean captured patch was preserved (for
example a concurrent driver edit or an exempt report path). `patchApplies` is null
for reviewers (no patch). A reviewer can be `completed` with `resultValid:false`
and `report:true`: read the prose report in `reports/<worker>.md`. Apply a worker
patch only via `apply` / `--apply`, after inspection. `worker` is the harness that
actually ran (may differ from the one you asked for — see auto-fallback).

On a **failed** run, two more fields explain why: `failureKind`
(`rate-limit` | `auth` | `timeout` | `frozen` | `stalled` | `other`) and `resetAt`
(best-effort reset hint for a limit). See the `result-handling` skill for how to
present these.

## Auto-fallback on transient failures

`delegate`/`review`/`adversarial-review` auto-fall-back to the next worker-ready
harness when the chosen worker hits a **transient** failure. Default policy:
`rate-limit` + `timeout` + `frozen` (another worker can do it now); **`auth` is surfaced**, not
routed around (it's a config fix); `other` and `stalled` never trigger it. Tune with
`AGENT_COLLAB_FALLBACK`: `off` (none), `on` (rate-limit+auth+timeout+frozen), or a
comma-list of kinds; `--no-fallback` forces a single worker. The result carries
`note`, `fellBackFrom[]` (`{worker, failureKind, resetAt}`), and — if every worker
failed eligibly — `allWorkersLimited: true`. Fallback only ever moves to another
**worker** harness; it never silently makes the driver do the task.

## Sync vs background

By default `delegate`/`review`/`adversarial-review` run **synchronously** (block until
done, with auto-fallback). With **`--background`** the runtime spawns a **detached**
worker and returns `{jobId, status:"running", background:true}` immediately — the run
survives a driver crash. Then:
- `status <jobId>` — poll once; `status <jobId> --wait [--timeout <s>]` — block until
  the job reaches a terminal status (or the process dies → `failureKind:"stalled"`).
- `result <jobId>` — the report + structured output once terminal.
- `cancel <jobId>` — kills the detached worker's whole process group.

Background runs a **single worker** (no auto-fallback — that's the synchronous path).
This is the brokerless version of the reference's async model (no app-server broker).

## Freeze detection (idle watchdog)

Every worker runs under an inactivity guard. **Progress** = stdout/stderr OR file
activity under the worktree, agy's log dir, or codex's `~/.codex/log` /
`~/.codex/sessions` dirs — because workers often log/write files instead of
streaming to the pipe (claude runs in streaming mode to provide a heartbeat). Only
NO-progress for `AGENT_COLLAB_IDLE_TIMEOUT` (default 600s; `0` disables) trips it
→ killed, surfaced as `failureKind: "frozen"`, and fallback-eligible. Codex and
qwen also have wider profile idle budgets for quiet long-running work. Separate
from the hard timeout below.

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
often emits `"High"`), common severity/verdict synonyms are mapped, unknown
top-level keys are stripped, and `next_steps` is optional. If JSON is still invalid
but prose exists, the review completes with `resultValid:false` and `report:true`:
read `tasks/<jobId>/reports/<worker>.md`.

## Env

- `AGENT_COLLAB_DATA` — out-of-repo state root (default: tmp/plugin-data).
- `AGENT_COLLAB_DRIVER` — default driver harness.
- `AGENT_COLLAB_SANDBOX` — OS-sandbox: `on` (all non-codex) | `off`. Default: opt-in
  for non-codex workers; **never codex** (it self-sandboxes). If it can't be applied,
  the run degrades to unsandboxed (`sandboxed:false` + a note) — breach detection still active.
- `AGENT_COLLAB_SANDBOX_STRICT=on` — tighten the macOS profile to **deny file-write by
  default** (confine writes to the work area + temp + harness state; blocks /tmp, other
  volumes, real repos). Default profile only blocks `$HOME`. Linux bwrap is already strict.
  Validate against your worker with `doctor --live` before relying on it.
- `AGENT_COLLAB_FALLBACK` — fallback policy: `off` | `on` (rate-limit+auth+timeout+frozen) | comma-list. Default: `rate-limit,timeout,frozen` (auth surfaces).
- `AGENT_COLLAB_TIMEOUT=<s>` — per-attempt worker HARD timeout in seconds (default 1200 = 20 min).
- `AGENT_COLLAB_IDLE_TIMEOUT=<s>` — inactivity timeout in seconds (default 600; 0 = off): no progress (output OR file activity) for this long → killed as `frozen`.
- `AGENT_COLLAB_BREACH_EXEMPT_PATHS=a,b` — comma-separated real-checkout paths that should be warnings, not hard breaches (for intentional reports/scratch output).
- `AGENT_COLLAB_CODEX_RESUME=off` — repair with a fresh re-send instead of resuming the codex thread (resume is on by default).
- `AGENT_COLLAB_ALLOW_INPLACE=on` — allow an UNISOLATED in-place run when a worktree can't be created (off by default → such a job is `blocked`, never run in the real cwd).
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

### Codex driver: third-party data-egress can be refused
Separately from the shell sandbox, Codex has a **data-egress / approval** policy that can
refuse to send your **private repo content to a third-party model** — observed: `codex` →
`agy` (Google/Gemini) blocked as an exfiltration risk **even after interactive approval** in
a non-interactive (`-p`) spawn, while `codex` → `claude` runs fine. This is a Codex-side
control; the runtime can't (and shouldn't) override it. Legitimate options:
1. Authorize it in **Codex's own config** (allowlist `node …/agent-companion.mjs`, or enable
   egress for trusted commands) — survives non-interactive spawns.
2. Run the companion **yourself in the shell** (you authorize the export) with
   `AGENT_COLLAB_DRIVER=codex`.
3. Practical default: from a codex driver, use **claude** as the worker/reviewer (it runs);
   reserve agy for when you've authorized Gemini egress; use codex primarily as a
   reviewer/analyst when another harness is driving.
Do **not** obfuscate the payload to slip past the check — it exists to gate third-party export.

## status vs result vs apply

- `status <jobId>` → the **runtime's job metadata** (status, breach, escapedPaths,
  attempts, failureKind, note, pid…). `--wait` blocks until terminal.
- `result <jobId>` → the **worker's deliverable**: its report (`reports/<worker>.md`)
  + structured self-report (`outputs/<worker>.json`). Self-report can disagree with
  the runtime (e.g. worker claims `changed:true` but the runtime captured nothing →
  `status` says `no-changes` with a `note`). Trust the runtime's captured state.
- `apply <jobId>` → lands the patch in the **working tree, unstaged** (clean index)
  so you inspect with `git diff` then commit; if you had pre-existing staged work it
  stays **staged**. Never auto-applies.

## Rules

- One job per invocation. Don't fabricate results if a run fails — surface stderr.
- The driver holds main-branch authority; workers only produce artifacts.
- agy is write-capable through the delegated worker path; if a worker reports changes
  but the runtime captures no patch, trust the runtime's `no-changes` diagnostic.
