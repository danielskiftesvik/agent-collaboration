<!--
  Example wiring for a project using the agent-collaboration plugin, with CLAUDE CODE
  as the driver. Paste this section into your project's own CLAUDE.md (and replace the
  <BOUNDARY CODE> placeholder). Requires: /plugin install agent-collaboration, and the
  worker CLIs you want on PATH (`codex`, `agy`). Run /agent-collab:setup once.
-->

## Cross-harness collaboration (autonomous)

This project delegates work to the strongest model for each task and gates hard work
behind an independent second opinion. Do this without asking.

### Route by model strength
Before delegating, classify the task type and let the runtime pick the worker:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-collaboration/scripts/agent-companion.mjs" recommend --task <type> --driver claude --json
```
(or just reason from the guide below). Then run `/agent-collab:delegate` or
`/agent-collab:review` with the returned `--worker`.

- **Hard reasoning / subtle bugs / adversarial review →** `codex` (reviewer/analyst only).
- **Careful refactor / planning / general SWE →** `claude` (use the native `Agent` tool — same harness).
- **Fast/mechanical/bulk edits, or large-context / whole-repo scans →** `agy` (Gemini: speed + big context).
- Full matrix + model profiles: `agent-companion.mjs recommend --profiles`.

### When a worker hits a subscription / rate limit
The runtime detects it (`failureKind: "rate-limit" | "auth"`) and **auto-falls-back to the
next worker-ready harness** — relay the result's `note` so the user knows a *different* model
did the work. If the result has `allWorkersLimited: true`, **stop and tell the user** (give
the soonest `resetAt`); never quietly do the task yourself in the driver. See the
`result-handling` skill.

### Collaborative-investigation gate (mandatory before non-trivial work)
Invoke the **`collaborative-investigation`** skill before debugging a non-trivial bug or
designing a non-trivial implementation. You form a hypothesis with an explicit confidence
score; an **independent second opinion** is taken from **codex** (Claude is the driver here,
so the gate defaults to the other reasoner). Implementation may start when both parties agree
on the approach and no high-severity objection remains unresolved. Record each party's
confidence for the log — the number itself is not the gate.

**Mandatory triggers:**
- The user says "are you sure", "make sure this is right", or "get a second opinion".
- The bug's repro is unclear, or there are multiple plausible root causes.
- A non-obvious design decision (data model, API shape, concurrency boundary).
- **Boundary code:** <LIST THIS PROJECT'S HIGH-RISK AREAS — e.g. schema/migrations, auth,
  payments/premium gating, sync/conflict logic, concurrency, security-sensitive paths>.

**Bypass** only for trivial work (copy/layout, tests on an existing pattern, grep-verified
renames, mechanical refactors) with the bypass block from the skill — and never after a user
override phrase.

The gate runs *before* implementation skills (TDD, plan execution), not instead of them.
