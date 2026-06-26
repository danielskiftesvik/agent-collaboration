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

## How to Delegate

### Claude Code
Use the custom slash commands:
- `/agent-collab:delegate --worker <codex|agy> "<task_brief>"`
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
