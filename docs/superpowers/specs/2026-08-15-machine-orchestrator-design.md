# Machine orchestrator: close the assign loop

Date: 2026-08-15  
Branch: `feat/peers-grok`  
Status: draft for review (not implemented)

## Problem

The Mini can already `peers assign` to the 2017 and get a peer-session reply. That is not the loop the operator wants.

Today `peers presence` is glued to one harness. Cursor consume is `PEER_ACK` + `--mode ask --trust`. The assign body never becomes work. You cannot tell the Mini “do this on the 2017 in Grok” and have a standing agent there decide how to run it.

## Goal

After Mini sends an assign to an awake machine:

1. A **standing orchestrator on that machine** reads the assign.
2. It **chooses** how to run it: short ping → local harness turn; real implementation → job-plane `delegate` on that machine.
3. Mini may **hint** a worker harness (`--hint-harness grok`). That flag is not
   `assign --harness`, which remains the **sender** identity on HTTP register.
   The machine may ignore the hint if that harness is down or a worse fit; it
   must say so.
4. **Done** is a peer reply (`done` / `refuse` / `rerouted`) plus a short summary. Mini does not pull patches. The operator inspects the 2017 if they want files.

This stays on the peer plane for distribution. Job plane stays local to the machine that does the work.

## Non-goals

- Mid-turn inject into an open TUI
- Bringing 2017 patches onto the Mini or auto-apply
- Mini forcing a session id
- HTTP `POST /peers/assign`
- LaunchAgents / reboot persistence
- Merge to `main`
- Turning `dispatch` / `delegate` into a chat bus
- Requiring the M4 Max to be awake

## Roles

| Role | Who | Does |
|---|---|---|
| Fleet assigner | Mini `main` | `peers assign --from main [--hint-harness grok] [--to-computer …]` |
| Machine orchestrator | `peers presence --harness grok` (or Claude/Codex) on that computer | Receives assign body as a **new turn**; routes; replies |
| Workers | Grok / Cursor / Codex / OpenCode, or `delegate` | Run on the **same** computer as the orchestrator |

`main` is not an assign target. One orchestrator presence per awake computer. Cursor `--mode ask` + `PEER_ACK` remains an explicit **wake-only** path, not the default for `old-orch`.

The 2017 orchestrator should be a write-capable harness (Grok is the intended default). Ask-mode Cursor cannot implement or `delegate`.

## Consume

`handleAssignedWork` still: accept → `busy` → work → reply → `idle`.

Default consume for the machine orchestrator is **not** Cursor PEER_ACK. It starts a new turn of `presence --harness` with a plugin-owned prompt that includes:

- assign id, from, optional harness hint, assign body
- standing policy (below)

Raw assign text is in that orchestrator prompt (it is the work). It is still not user consent. Slash-looking text stays text.

Per-harness **worker** resumes (when the orchestrator starts a ping-style harness turn) stay as already specified: Codex `exec resume`, Grok `--resume`/`--single` or `--continue`, OpenCode `--session`. No Cursor `--mode ask --trust` on those argv. Unknown harness remains `inject-stub`. Claude stays native or `native_required`.

## Policy (in the orchestrator prompt)

1. **Ping** — coordination, status, “look at X”. Do it in this turn, or start the hinted harness’s idle resume if that session is required. Reply in a few lines.
2. **Implement** — change the repo, multi-step. Run `delegate` on this machine, wait, reply with status + summary. Do not apply on Mini.
3. **Hint** — if Mini passed `--hint-harness grok` and Grok is usable here, use it. Otherwise pick a ready harness and reply `rerouted` with the harness used. Never fail silent. Never PEER_ACK as a substitute for work.
4. **Refuse** — no capacity, unsafe, missing tool. Same envelope, reason in the text.

Busy is published before the orchestrator turn starts. Idle only after the reply is enqueued. A second `peers assign` still skips that computer.

## Reply

Unchanged envelope: `origin: peer-session`, `from` = orchestrator name (`old-orch`), `to` = `main`, `isConsent: false`.

First line, so Mini can parse without an LLM:

```
assign <id> done|refuse|rerouted
```

Then a short body: what happened, harness actually used, and if delegated, the **local job id** as a pointer only.

`peers assign --wait-seconds` keeps polling `GET /peers/inbox` on the destination mailbox with the register token. Success = that first line is present. Timeout is reported on Mini; a late reply can still land in `main`’s remote inbox (`peers inbox --name main`).

A dead orchestrator turn must still enqueue `refuse` and return to `idle`. Reply to an HTTP-registered `main` (`reach: cross-machine`) stays `allowCrossMachine` enqueue on this mailbox. Plain `peers send` to cross-machine dest stays fail-closed.

## Errors

| Case | Behavior |
|---|---|
| No eligible machine | `PEER_NO_CAPACITY` (unchanged) |
| Orchestrator turn dies / times out | `assign <id> refuse: …`, idle |
| Hinted harness missing | `rerouted` or `refuse`, never silent Cursor ACK |
| Mailbox EPERM | Honest; `AGENT_COLLAB_PEERS_DIR` |
| File-path send to `reach: cross-machine` | Fail-closed |
| Reply enqueue fails | Presence stays up; idle; error recorded |

## Tests

Drive shipped consume / reply / assign functions (no mocked unit-under-test):

- Grok / Codex / OpenCode worker argv still has no Cursor `--mode ask --trust`
- Orchestrator wake includes assign id + policy; not a PEER_ACK-only first line
- Hint ignored → `rerouted` + harness used
- First line `done|refuse|rerouted`; idle after a failed turn
- Existing skip-busy, skip-asleep, prefer-idle, assign ⟂ `delegate` import checks stay green

## Rollout

1. Implement orchestrator consume + policy prompt + reply first-line contract on `feat/peers-grok`.
2. Point 2017 presence at Grok (write-capable), same `PEERS_DIR` as serve. Restart presence after pull.
3. Mini keeps `main` as assigner. Prove: ping assign → reply; implement assign → 2017 `delegate` + reply with job id; hint-Grok-when-down → `rerouted` or `refuse`.

## Risks

- Grok `--single` on every assign costs a turn even for pings. Accepted: the orchestrator *is* Grok; pings stay short.
- `delegate` from an orchestrator turn can nest long jobs. Idle/busy covers the machine; the orchestrator turn must wait or the reply will lie. The orchestrator waits.
- Cursor wake-only path will confuse operators if left as default `old-orch`. Default presence harness for this fleet is Grok unless the operator explicitly asks for wake-only.
