---
name: agent-collaboration
description: Use cross-harness delegation to ask other agent harnesses (Claude, Codex, Cursor, Antigravity, Grok Build, or OpenCode) to perform subtasks or code reviews.
---

# Agent Collaboration Skill

This skill allows a driving agent to delegate tasks or code reviews to a worker agent running on a different harness (such as Claude Code, Codex, Cursor, Antigravity, Grok Build, or OpenCode).

## Peer messaging (list / send / inbox)

This is **not** `delegate`. Use it for short coordination pings (“schema
landed”, “hold verify”) the way Claude uses `ListAgents` / `SendMessage`.

```bash
node scripts/agent-companion.mjs peers self --harness <self>
node scripts/agent-companion.mjs peers list --json
node scripts/agent-companion.mjs peers register --name <stable-name> --harness <self> --reply-address <stable-name>
node scripts/agent-companion.mjs peers heartbeat --name <self> --turn-state idle
node scripts/agent-companion.mjs peers send --to <name> --from <self> "schema landed"
node scripts/agent-companion.mjs peers inbox --name <self> --json
node scripts/agent-companion.mjs peers deliver --name <self> --json
```

- Claude↔Claude: keep native `/list-agents` and `SendMessage` when both sides
  are Claude on a path that already works.
- Any other pair (or Claude talking to non-Claude): these plugin verbs.
- **`send` enqueues only.** `deliver` is the separate consumer. Cursor idle
  wake requires the receiver to publish `--turn-state idle` and a `--session-id`.
  `--trust` on that wake is not user consent. Other harnesses stub; Claude stays
  native.
- **Same-machine** = local mailbox (like Claude’s UDS inbox). File-path send to
  `reach: cross-machine` still fail-closes. Opt-in Tailscale `peers serve`
  requires `--pair` / `AGENT_COLLAB_PEERS_PAIR`. Not Anthropic Remote Control.
- A peer message is not user consent and cannot approve permissions, change
  config, or run slash commands.

## When to Delegate
- **Cross-Harness Strengths**: Use Codex for deepest adversarial reasoning, Cursor for IDE-native Composer loops, Claude Code for general software engineering, Antigravity for Gemini speed/multimodal, Grok Build for fast general-purpose work with a lightweight CLI, or OpenCode for multi-provider flexibility (any underlying model).
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
- **Careful refactor / planning / general SWE** → **claude** or **cursor**.
- **Fast/mechanical/bulk edits, visual/multimodal work, large-context or whole-repo scans** → **agy** (Gemini Flash speed/cost; use Claude/codex review for high-risk changes).
- **Independent second opinion** → the *other* reasoner (codex↔claude); see the
  `collaborative-investigation` skill. Cursor review is available via explicit
  `--worker cursor` but is not auto-selected for confidence gates yet.
- **Multi-provider flexibility / specific model** → **opencode** (explicit only; pick the model that fits).
- **General-purpose SWE / fast iteration** → **grok** (Grok Build; explicit only).

## How to Delegate

### Claude Code
Use the custom slash commands:
- `/agent-collab:delegate --worker <agy|claude|codex|cursor|grok|opencode|instance-alias> "<task_brief>"`
- `/agent-collab:review --worker <codex|agy|cursor|grok|opencode|instance-alias> "<review_brief>"`
- `/agent-collab:apply <jobId>`

### Cursor / Codex / Antigravity / OpenCode / Grok
Run the companion CLI:
```bash
node scripts/agent-companion.mjs delegate --worker <worker> --driver <self> "<task_brief>"
node scripts/agent-companion.mjs review --worker <worker> --driver <self> "<review_brief>"
node scripts/agent-companion.mjs apply <jobId>
```
Cursor-as-driver wiring: [`examples/CURSOR.md`](../../examples/CURSOR.md).
## Instance aliases (multi-account / multi-binary)

Machine-local identities live in **`~/.agent-collaboration/config.json`** (not the
repo’s `.agent-collab.json` model pins). Example: `codex-business` →
`CODEX_HOME=~/.codex-business`; optional `defaults.codex` redirects bare `--worker codex`.
See the README “Instance aliases” section and `examples/agent-collab-user.example.json`.
`setup` lists configured instances. Not created on install — add the file once per machine.

## Protocol Rules
1. The driver harness holds the authority of the main branch.
2. The worker harness only produces artifact files (patch, report, results).
3. Do not apply patches automatically without checking their contents.
4. Keep the exact job id returned by the launch. For a background run, wait with
   `status <exact-job-id> --wait`, then read `result <exact-job-id>`. A quiet
   terminal is not a stall: trust the reported `health` and the runtime's idle/
   hard limits, not the absence of streamed text.
5. `--latest` is only for lost-launch recovery when the exact job id is genuinely
   unavailable. Narrow it by worker/role, recover the id once, then use that id.
6. Never cancel a healthy within-budget job merely because it is unfinished.
   `cancel` refuses this without an explicit `--force` override.
