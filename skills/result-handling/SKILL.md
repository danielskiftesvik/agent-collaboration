---
name: result-handling
description: How to present the output of a cross-harness worker or reviewer back to the user, and what NOT to do with it. Use after running /agent-collab:delegate, /agent-collab:review, or the companion's delegate/review commands.
---

# Result Handling

How the driver presents what a delegated worker or reviewer produced — and the
hard rules about acting on it.

## Presenting a review

- Preserve the review's structure: **verdict, summary, findings, next steps.**
- Order findings by **severity** (critical → high → medium → low).
- Use the file paths and line numbers **exactly** as reported.
- Preserve evidence boundaries: if the reviewer marked something as an inference,
  uncertainty, or open question, keep that distinction. Don't upgrade a
  hypothesis into a fact.
- If there are no findings, say so plainly and keep any residual-risk note brief.

### CRITICAL — a review is not a license to edit

After presenting review findings, **STOP.** Do not make code changes, do not fix
issues, do not start editing. You MUST explicitly ask the user **which findings,
if any, they want addressed** before touching a single file. Auto-applying fixes
from a review is forbidden, even when the fix looks obvious.

## Presenting a worker result

- Report the `status` (`completed` / `no-changes` / `conflicted` / `breach` /
  `failed`), whether it `changed` files, and whether the patch `patchApplies`
  cleanly.
- **`breach` — STOP and surface loudly.** The worker wrote *outside* its worktree,
  into the driver's real checkout (`escapedPaths` lists what). The driver did **not**
  apply these; tell the user to inspect/revert them, and do not trust that worker as
  an implementer here.
- **`no-changes`** — the worker reported done but captured **no patch**. Don't read
  that as success; say it produced nothing and ask how to proceed.
- The worker's deliverable is the **patch**, not the metadata JSON. A
  `completed` worker with `resultValid: false` just means the harness replied in
  prose — the patch is still the artifact.
- **Always show / inspect the patch before applying.** Apply only with the
  user's go-ahead, via `/agent-collab:apply <jobId>`. Never auto-apply, and never
  apply a `conflicted` patch without resolving it.
- **After `apply`:** the change lands in the **working tree, unstaged** — inspect
  with `git diff`, then commit yourself. Any pre-existing staged work is left
  untouched (only the patch's own paths are unstaged). A patch that won't apply
  cleanly is **rejected without dirtying the tree** (`applied:false`, no half-applied
  conflict markers).
- If the worker `changed` nothing, say so; don't invent a result.

## Failures and edge cases

- If the run **failed or returned invalid output**, surface the worker's actual
  output and the most actionable stderr lines. Do **not** fabricate a result.
- If a reviewer run is `completed` with `resultValid:false` and `report:true`, the
  model produced prose but invalid JSON. Read the saved prose report; do not discard
  it as a task failure.
- Do **not** silently fall back to doing the task yourself in the driver. If the
  cross-harness run failed, report the failure and ask how to proceed.
- If the worker was never successfully invoked, don't generate a substitute
  answer at all.
- If setup or authentication is required, direct the user to
  `/agent-collab:setup` rather than improvising an auth flow.

## Subscription / rate limits (how to tell, what to do)

A failed result is **classified** so you don't have to guess. Read these fields:

- `failureKind: "frozen"` — the worker made **no progress** (no stdout/stderr AND no
  file activity) for the idle window (`AGENT_COLLAB_IDLE_TIMEOUT`, default 10 min) and
  was killed before the hard timeout. Auto-falls-back. A genuinely-stuck worker; tell
  the user it hung. (If a worker is just slow-but-working, raise the idle budget.)
- `failureKind: "timeout"` — the worker was killed at the **hard** time budget
  (deep reasoners like codex on big diffs are the usual case). Auto-falls-back; to
  keep the same worker, retry with a bigger `--timeout` / `AGENT_COLLAB_TIMEOUT`.
- `failureKind: "rate-limit"` — the worker hit a subscription/usage/quota/rate
  limit (or transient `overloaded`). `resetAt` carries a best-effort reset hint
  (e.g. `"10pm"`, `"60"` seconds) when the harness reported one.
- `failureKind: "auth"` — the worker isn't logged in / the key is invalid. By
  default this is **surfaced, not routed around** (a different worker can't fix the
  *config*) — point the user at `/agent-collab:setup` or the harness's own `login`.
- `failureKind: "stalled"` — a background job's process died without writing a
  terminal result. Surface it and inspect `run.log` / artifacts; retry as a fresh job.
- `failureKind: "other"` — an ordinary task failure. Surface it; do **not** treat
  it as a limit.

**What the runtime already did:** by default it **auto-falls-back to the next
worker-ready harness** (never the driver) on a **transient** failure —
`rate-limit`, `timeout`, or `frozen` (auth is surfaced instead; tune with
`AGENT_COLLAB_FALLBACK=off|on|<kinds>`). The result then carries:

- `note` — a human sentence describing the fallback ("Auto-fell back to claude
  after agy (rate-limit, resets 10pm) was unavailable."). **Always relay this
  note to the user** — the work was done, but by a *different* model than asked.
- `fellBackFrom[]` — `{worker, failureKind, resetAt}` for each skipped harness.
- `allWorkersLimited: true` — **every** worker-ready harness failed in a
  fall-back-eligible way. Nothing succeeded. Surface it, give the soonest
  `resetAt`, and ask whether to wait, switch accounts, or proceed differently.

**The one hard rule:** auto-fallback only ever moves to **another worker
harness**. It must **never** become "the driver quietly does it single-party."
When all workers are limited (`allWorkersLimited`), stop and tell the user — do
not silently absorb the task into the driver.

To force a single worker (no fallback), the caller can pass `--no-fallback` (or
set `AGENT_COLLAB_FALLBACK=off`); then the limit just surfaces for you to relay.

## By harness

- **codex / claude / agy** — emit structured findings/result JSON: present findings by
  severity, preserve evidence boundaries.
- **agy** — usable as reviewer and write-worker (default **Gemini Flash**;
  `AGENT_COLLAB_AGY_CLASS=Pro` for deeper passes). Its adapter pins model flags before
  the prompt and harvests patches from agy's internal worktree when needed.
- **codex** — usable as reviewer and write-worker; strongest fit is hard reasoning,
  subtle bug analysis, and adversarial review. It can be slower and quiet for long
  stretches, so the runtime gives it a wider idle budget.
- **claude** — usable as a write-worker; when Claude Code is also the driver, use the
  native Agent tool.

Observed reliability: **agy is the dependable workhorse** for fast patch delivery
and **codex is the specialist** for the hardest review reasoning — high signal but
slower and sometimes quiet for long stretches. For high-stakes review, running both
(agy as the floor, codex as the ceiling) gives the best coverage. Severity/verdict
cosmetics and missing `next_steps` are normalized automatically, so don't reject a
codex report for those.

## Why this matters

A delegated agent runs unattended (e.g. `agy --dangerously-skip-permissions`).
The driver holds the authority of the main branch — keeping "review," "produce a
patch," and "apply a patch" as distinct, user-gated steps is what keeps a
delegated run from making unwanted changes.
