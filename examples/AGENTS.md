<!--
  Example wiring for a project using the agent-collaboration runtime, with CODEX or
  ANTIGRAVITY as the driver. Paste this into your project's AGENTS.md (the convention file
  Codex/other agents read) and replace <BOUNDARY CODE>. These harnesses drive over the
  shell, so commands invoke the companion CLI directly. Set COMPANION to its path, e.g.
  ~/.../agent-collaboration/scripts/agent-companion.mjs.

  NOTE: when driving from a sandboxed harness (Codex), run the companion with escalated /
  network-enabled permissions — it spawns a worker that calls an external API.
-->

## Cross-harness collaboration (autonomous)

Delegate work to the strongest model for each task and gate hard work behind an independent
second opinion. Do this without asking.

### Route by model strength
Classify the task type, then let the runtime pick the worker (it excludes you, the driver):

```
node "$COMPANION" recommend --task <type> --driver <self> --json   # <self> = codex or agy
```
Then `node "$COMPANION" delegate --worker <returned> --driver <self> "<brief>"` (or `review`).

- **Hard reasoning / subtle bugs / adversarial review →** `codex`.
- **Careful refactor / planning / general SWE →** `claude`.
- **Fast/mechanical/bulk edits, or large-context / whole-repo scans →** `agy` (Gemini).
- Full matrix + model profiles: `node "$COMPANION" recommend --profiles`.

### Collaborative-investigation gate (mandatory before non-trivial work)
This is the `collaborative-investigation` methodology (see the plugin's skill of that name).
Before debugging a non-trivial bug or designing a non-trivial implementation: form a
hypothesis with an explicit confidence score, then take an **independent second opinion**
from another harness. When **Codex** is driving, the gate defaults the second opinion to
**claude** (the other strong reasoner); when **agy** is driving, to **codex**. Strip your
confidence number before sending (anti-anchoring). Implement only at **≥90% mutual confidence
with agreement**:

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
