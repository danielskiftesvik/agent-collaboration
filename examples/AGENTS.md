<!--
  Example wiring for a project using the agent-collaboration runtime, with CODEX or
  ANTIGRAVITY as the driver. Paste this into your project's AGENTS.md (the convention file
  Codex/other agents read) and replace <BOUNDARY CODE>. These harnesses drive over the
  shell, so commands invoke the companion CLI directly. Set COMPANION to its path, e.g.
  ~/.../agent-collaboration/scripts/agent-companion.mjs.

  NOTE: when driving from a sandboxed harness (Codex), run the companion with escalated /
  network-enabled permissions — it spawns a worker that calls an external API.

  NOTE (Codex driver): Codex's data-egress policy may refuse to send private repo content to a
  THIRD-PARTY model — observed: codex->agy (Gemini) blocked even after approval; codex->claude
  runs fine. Authorize it in Codex's config, run the companion yourself, or just use claude as
  the worker from a codex driver. See the companion-runtime skill's troubleshooting note.
-->

## Cross-harness collaboration (autonomous)

Delegate work to the strongest model for each task and gate hard work behind an independent
second opinion. Do this without asking.

> **Driver auto-detects** for all four (Codex via `CODEX_THREAD_ID`, agy via
> `ANTIGRAVITY_*`, OpenCode via `OPENCODE_SESSION`, Claude Code via `CLAUDECODE`), so no setup
> is normally needed. `--driver <self>` / `AGENT_COLLAB_DRIVER=<self>` remains the
> deterministic override if detection ever misses in your environment.

### Route by model strength
Classify the task type, then let the runtime pick the worker (it excludes you, the driver):

```
node "$COMPANION" recommend --task <type> --driver <self> --json   # <self> = codex, agy, or opencode
```
Then `node "$COMPANION" delegate --worker <returned> --driver <self> "<brief>"` (or `review`).

- **Hard reasoning / subtle bugs / adversarial review →** `codex`.
- **Careful refactor / planning / general SWE →** `claude`.
- **Fast/mechanical/bulk edits, or large-context / whole-repo scans →** `agy` (Gemini).
- **Multi-provider flexibility →** `opencode` (explicit only; pin a model in `.agent-collab.json`).
- Full matrix + model profiles: `node "$COMPANION" recommend --profiles`.

### When a worker hits a subscription / rate limit
The runtime detects it (`failureKind: "rate-limit" | "auth"`) and **auto-falls-back to the
next worker-ready harness** — relay the result's `note` so the user knows a *different* model
did the work. If `allWorkersLimited: true`, **stop and surface it** (with the soonest
`resetAt`); never silently complete the task single-party. See the `result-handling` skill.

### Collaborative-investigation gate (mandatory before non-trivial work)
This is the `collaborative-investigation` methodology (see the plugin's skill of that name).
Before debugging a non-trivial bug or designing a non-trivial implementation: form a
hypothesis with an explicit confidence score, then take an **independent second opinion**
from another harness. When **Codex** is driving, the gate defaults the second opinion to
**claude** (the other strong reasoner); when **agy** is driving, to **codex**. Strip your
confidence number before sending (anti-anchoring). Implementation may start when both parties
agree on the approach and no high-severity objection remains unresolved. Record each party's
confidence for the log — the number itself is not the gate:

```
node "$COMPANION" recommend --task second-opinion --driver <self> --json
node "$COMPANION" delegate --worker <returned> --role reviewer --driver <self> "<hypothesis WITHOUT your confidence + the assessment format>"
```

**Mandatory triggers:**
- The user says "are you sure", "make sure this is right", or "get a second opinion".
- Unclear repro, or multiple plausible root causes.
- A non-obvious design decision (data model, API shape, concurrency boundary).
- **Boundary code:** <LIST THIS PROJECT'S HIGH-RISK AREAS — e.g. schema/migrations, auth,
  payments/gating, sync/conflict logic, concurrency, security-sensitive paths>.

**Bypass** only for trivial work, and never after a user override phrase. If the second
opinion is unavailable, do **not** silently proceed single-party — surface it as a user
decision.
