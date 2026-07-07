---
name: collaborative-investigation
description: Use BEFORE debugging a non-trivial bug or designing a non-trivial implementation, and whenever the user says "are you sure", "make sure this is right", or "get a second opinion". Forces the driver to form a hypothesis with an explicit confidence score, then gets an INDEPENDENT second opinion from a different harness (via the agent-collaboration runtime). Implementation starts when both parties agree and no high-severity objection remains unresolved.
---

# Collaborative Investigation

A two-party gate that prevents implementation drift on hard problems. The **driver**
investigates first; an **independent reviewer on a different harness** validates; and
**neither party's word alone is sufficient**. Implementation may start when both
parties agree on the approach and no high-severity objection remains unresolved.
Record each party's confidence for the log — the number itself is not the gate.

This skill is harness-agnostic: whichever harness is driving (Claude Code, Codex, or
Antigravity) forms the hypothesis, and the second opinion comes from another harness via
the `agent-collaboration` runtime.

## When this applies

**Mandatory** — any of:
- The user said "are you sure", "make sure this is right", "get a second opinion", or
  invoked this skill directly. (These override any bypass.)
- The bug's reproduction path is unclear, or there are multiple plausible root causes.
- The implementation needs a non-obvious design decision (data model, API shape, threading/
  concurrency boundary).
- The change touches **boundary code** for this project. *Boundary code is project-specific —
  define it in your CLAUDE.md / AGENTS.md* (see `examples/`). If a project list exists, honor it.

**Optional (bypass allowed):** single-file copy/layout tweaks, tests against an existing
pattern, grep-verifiable renames, mechanical refactors with an obvious diff.

**Bypass** requires ALL of: confidence is 100%; the change is in the optional list; you
enumerate each mandatory trigger and why it doesn't apply; and no user override phrase was
used. Document it:

```
Collaborative gate: bypassed.
Bucket: optional — <which>.
Mandatory triggers ruled out: <repro clear; no design decision; not boundary code; no user override>.
Confidence: 100% — <one sentence>.
```

## The flow

1. **Classify** mandatory vs optional (one line). Optional + 100% + trivial → bypass note → implement.
2. **Investigate** and write a hypothesis block (Step 1).
3. **Pick the reviewer** with `recommend` (Step 2).
4. **Get the independent second opinion** (Step 3, anti-anchored).
5. **Synthesize and gate** → PROCEED / ITERATE / ASK USER (Step 4).

## Step 1 — Hypothesis (with a confidence number)

Read the relevant code yourself (or dispatch an Explore agent). Then produce:

```markdown
### <driver>'s hypothesis
**Problem statement:** one sentence.
**Root cause / chosen approach:** the specific file:line or design decision, and why not the obvious alternative.
**Evidence:** cite each load-bearing fact with `file:line` or "verified by grep"; mark inferences `(inferred)`.
**Risks / unknowns:** what would invalidate this; what you didn't check.
**Confidence: NN%** — one sentence justifying the number.
```

Calibration: high confidence = verified end-to-end; medium confidence = strong but
with unchecked assumptions; low confidence = keep investigating. The reviewer
validates a real hypothesis — it does not magically raise your number. If your
number rises without new evidence in their report, that's drift: keep the honest
number and ITERATE.

## Step 2 — Pick the reviewer (different harness)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" recommend --task second-opinion --driver <self> --json
```

Defaults to the other strong reasoner — **codex if Claude is driving, claude if Codex is
driving** (agy driving → codex). Use the returned `worker`.

For an investigation touching sensitive/local-only data, use
`recommend --task local-only` instead — this routes to `qwen` (local, never a
cloud API) or returns none if qwen isn't available, never a substituted cloud
harness. See [harness-prompting's qwen guide](../harness-prompting/references/qwen.md)
for how to keep the brief itself from leaking the sensitive content before qwen runs.

## Step 3 — Independent second opinion (anti-anchored)

**Anti-anchoring (critical):** strip the `**Confidence: NN%**` line before sending — the
reviewer must form its own number. If you forget, re-run.

Delegate a read-only review to the recommended worker:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-companion.mjs" delegate \
  --worker <recommended> --role reviewer --driver <self> \
  "Independently review this hypothesis. Do not rubber-stamp; verify the cited files yourself, look for missed root causes / side effects / failure modes, and state YOUR OWN confidence (0–100%).

<paste the hypothesis WITHOUT the Confidence line>

Report exactly:
### <reviewer>'s assessment
Agree / partially / disagree: one word + one sentence.
What the driver got right: bullets, cite file:line.
What was missed or wrong: bullets, cite file:line (empty is fine).
My confidence: NN% — one sentence.
If disagree, my alternative: same structure, or n/a."
```

Read the worker's report (`… result <jobId>`). The assessment is the report text.

## Step 4 — Synthesize and gate

```markdown
### Gate decision
- <driver> confidence: NN%   - <reviewer> confidence: NN%
- Agreement: full / partial / none   - Disagreements: <bullets / none>
- Resolution: PROCEED | ITERATE | ASK USER
```

- **PROCEED** — both parties agree on the approach and no high-severity objection
  remains unresolved. Implement (then your normal TDD/plan skills apply — this
  gate runs *before* them, not instead).
- **ITERATE** — confidence is low/medium for a load-bearing claim, or a substantive
  disagreement can be closed by more investigation. Back to Step 1. After two
  loops without convergence, escalate to ASK USER.
- **ASK USER** — disagreement is a product/scope call code can't settle.

### If the reviewer is unavailable or returns garbage
Retry once. If it still fails, **do not silently proceed single-party** — surface it (this is
the `result-handling` rule):

```
Collaborative gate: BLOCKED — second opinion unavailable.
<driver> confidence: NN%   Reviewer: <error/timeout/malformed>
Options: retry · authorize single-party (YOU own the residual risk) · rescope.
```

## Anti-patterns
- No confidence number — "I think this is right" is a vibe, not an investigation.
- Forgetting to strip the confidence (anchors the reviewer; kills independence).
- Treating the reviewer as ground truth — if it contradicts a load-bearing fact, re-verify yourself.
- Inflating your confidence number to justify proceeding — that's drift; ITERATE instead.
- Running the gate on a typo. The bypass exists for a reason.
