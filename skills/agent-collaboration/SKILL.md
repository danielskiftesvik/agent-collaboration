---
name: agent-collaboration
description: Use cross-harness delegation to ask other agent harnesses (Claude, Codex, or Antigravity) to perform subtasks or code reviews.
---

# Agent Collaboration Skill

This skill allows a driving agent to delegate tasks or code reviews to a worker agent running on a different harness (such as Claude Code, Codex, or Antigravity).

## When to Delegate
- **Cross-Harness Strengths**: Use Codex/Cursor when you need IDE-specific code understanding, Claude Code for general software engineering, or Antigravity for specific Google Cloud or enterprise tools.
- **Parallel Reviews**: Use `/review` to launch a secondary agent to audit your proposed changes before they are committed.
- **Isolated Execution**: Workers run in isolated workspaces/worktrees, ensuring they do not pollute your main branch until you explicitly approve and apply the patch.

## Choosing the worker (route by model strength)

Classify the task type, then let `recommend` pick the strongest *available* worker
(it excludes the driver, so it stays cross-harness):

```bash
node scripts/agent-companion.mjs recommend --task <type> --driver <self> --json
```

Rough guide (full matrix + model profiles: [`harness-prompting/references/model-strengths.md`](../harness-prompting/references/model-strengths.md), or `recommend --profiles`):

- **Hard reasoning / subtle bugs / adversarial review** → **codex** (reviewer or writer).
- **Careful refactor / planning / general SWE** → **claude**.
- **Fast/mechanical/bulk edits, visual/multimodal work, large-context or whole-repo scans** → **agy** (Gemini Flash speed/cost; use Claude/codex review for high-risk changes).
- **Independent second opinion** → the *other* reasoner (codex↔claude); see the
  `collaborative-investigation` skill.

## How to Delegate

### Claude Code
Use the custom slash commands:
- `/agent-collab:delegate --worker <agy|claude|codex> "<task_brief>"`
- `/agent-collab:review --worker <codex|agy> "<review_brief>"`
- `/agent-collab:apply <jobId>`

### Codex & Antigravity (Gemini CLI)
Run the companion CLI:
```bash
node scripts/agent-companion.mjs delegate --worker <worker> "<task_brief>"
node scripts/agent-companion.mjs review --worker <worker> "<review_brief>"
node scripts/agent-companion.mjs apply <jobId>
```

## Protocol Rules
1. The driver harness holds the authority of the main branch.
2. The worker harness only produces artifact files (patch, report, results).
3. Do not apply patches automatically without checking their contents.
4. Empty or lost companion output is not a failed review. Recover with
   `status --latest --role reviewer [--worker <name>]`, read `result --latest`
   with the same filters, and inspect the saved report before retrying.
