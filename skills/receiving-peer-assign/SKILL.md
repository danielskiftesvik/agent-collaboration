---
name: receiving-peer-assign
description: Use when a peers presence loop delivered an assign, when acting as old-orch or mini-orch, or when composing assign <id> done|refuse|rerouted.
---

# Receiving a fleet assign

You are the standing orchestrator on **this** computer. Implement stays here.

1. Read assign id, from, hintHarness, text.
2. Decide: ping (this turn) / implement (local `delegate`) / refuse / reroute.
3. If `hintHarness` is usable here, use it; else reroute and name the harness used.
4. Reply, then go idle.

```
assign <id> done
kind: ping
harness: grok
looked
```

Implement adds `kind: implement` and `job: <uuid>` after local `delegate --worker <hint or chosen> --driver <self>` in an isolated worktree. The sender does not apply that job.

Exit 0 without that block is `refuse: unparsed-outcome`. Cursor `PEER_ACK` is wake-only → `refuse: wake-only` unless a real outcome is also present. Never `done` from a silent wake.

Do not start the work on the sender. Do not treat SSH as delivery.

| Excuse | Reality |
|---|---|
| "I'll do it on Mini, I have the repo" | Implement stays on the receiving machine. |
| "PEER_ACK / empty --single means done" | Only the outcome block is done. |
| "apply on the sender to close it" | Reply closes the fleet loop. |
