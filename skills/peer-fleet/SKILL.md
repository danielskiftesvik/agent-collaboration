---
name: peer-fleet
description: Use when work must run on another computer (Mini, 2017 MacBook, M4 Max), when the user says assign, fleet, peers assign, lineage, or collab UI, or when tempted to delegate, apply, or SSH instead of a fleet assign.
---

# Peer fleet

This plugin has **two planes**. Mixing them is a bug.

| | Job plane (`agent-collaboration`) | Peer plane (this skill) |
|---|---|---|
| Where | Same computer, other harness | Another computer |
| Commands | `delegate` / `review` / `apply` | `peers assign` + `peers reply` |
| Artifact | Isolated worktree patch | Mailbox reply |
| Loop closes | `apply <jobId>` on the machine that ran the job | `assign <id> done\|refuse\|rerouted` |
| Worker choice | `--worker` (command) | `--hint-harness` (hint only) |

`delegate` never leaves this computer. `apply` never pulls a remote job onto the sender. SSH is ops/debug, not the work path. Do not import `dispatch.mjs` on the peer plane.

**REQUIRED SUB-SKILL:** `setting-up-collaboration` when serve, presence, pair, or workers are not standing yet.
**REQUIRED SUB-SKILL:** `assigning-across-machines` when sending.
**REQUIRED SUB-SKILL:** `receiving-peer-assign` when you are `old-orch` / `mini-orch` (or any standing consumer).

Watch: `http://<this-machine>:8744/collab` auto-updates. `peers lineage --id <id>`. Not a chat log.

Flags and env: `companion-runtime`. Operator map: `docs/specs/peers-collaboration-guide.md`.

| Excuse | Reality |
|---|---|
| "delegate is the same plugin" | Same plugin, different plane. Other computer → assign. |
| "apply the remote job here" | That job mailbox is on the receiving machine. Fetch git if you need the files. |
| "SSH is faster" | SSH is debug. Assign is the work path. |
