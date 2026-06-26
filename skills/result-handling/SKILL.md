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

- Report the `status` (`completed` / `conflicted` / `failed`), whether it
  `changed` files, and whether the patch `patchApplies` cleanly.
- The worker's deliverable is the **patch**, not the metadata JSON. A
  `completed` worker with `resultValid: false` just means the harness replied in
  prose — the patch is still the artifact.
- **Always show / inspect the patch before applying.** Apply only with the
  user's go-ahead, via `/agent-collab:apply <jobId>`. Never auto-apply, and never
  apply a `conflicted` patch without resolving it.
- If the worker `changed` nothing, say so; don't invent a result.

## Failures and edge cases

- If the run **failed or returned invalid output**, surface the worker's actual
  output and the most actionable stderr lines. Do **not** fabricate a result.
- Do **not** silently fall back to doing the task yourself in the driver. If the
  cross-harness run failed, report the failure and ask how to proceed.
- If the worker was never successfully invoked, don't generate a substitute
  answer at all.
- If setup or authentication is required, direct the user to
  `/agent-collab:setup` rather than improvising an auth flow.

## By harness

- **codex / claude** — emit structured findings/result JSON: present findings by
  severity, preserve evidence boundaries.
- **agy** — for a *worker*, the **patch is the deliverable** (a `completed` worker
  may have `resultValid: false` — that just means it replied in prose; show the
  patch). agy *reviews* are unreliable (it narrates on Flash) — prefer codex/claude
  for reviews; if an agy review came back invalid, show its prose and say so.

## Why this matters

A delegated agent runs unattended (e.g. `agy --dangerously-skip-permissions`).
The driver holds the authority of the main branch — keeping "review," "produce a
patch," and "apply a patch" as distinct, user-gated steps is what keeps a
delegated run from making unwanted changes.
