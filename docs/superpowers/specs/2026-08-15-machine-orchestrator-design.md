# Machine orchestrator: close the assign loop

Date: 2026-08-15  
Branch: `feat/peers-grok`  
Status: accepted draft (Cursor challenge folded in; not implemented)

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

`main` is not an assign target. `pickMachine` / `eligibleMachines` **exclude**
the name `main` (and the assign `--from` name) unless the operator passes an
explicit `--to` session name. `--to-computer` alone must still land on an
`*-orch` session on that computer, never `main`.

One orchestrator presence per awake computer. Cursor `--mode ask` + `PEER_ACK`
remains an explicit **wake-only** path, not the default for `old-orch`.
**PEER_ACK must never produce `assign <id> done`.** Wake-only consume replies
`assign <id> refuse: wake-only` (or a distinct non-done reason). `done` is only
legal after an orchestrator outcome handshake (below).

The 2017 orchestrator should be a write-capable harness (Grok is the intended default). Ask-mode Cursor cannot implement or `delegate`.

## Consume

`handleAssignedWork` still: accept → `busy` → work → reply → `idle`.

Default consume for the machine orchestrator is **not** Cursor PEER_ACK and
**not** `buildWakePrompt(id)` (PEER_ACK-only) for Grok/Codex/OpenCode. Those
worker resume helpers stay for **orchestrator-started worker turns**, not for
the orchestrator turn itself.

The orchestrator turn is a new turn of `presence --harness` with
`buildOrchestratorPrompt`: assign id, from, `hintHarness`, assign body, and
the policy below. Assign body in that prompt is the work. It is not user
consent. Slash-looking text stays text.

**Reply ownership:** the orchestrator turn prints exactly one outcome block
(last non-empty lines). `handleAssignedWork` **parses** it and enqueues
**one** `replyToAssign`. The turn must not call `peers reply` itself (double
enqueue). Unparsed stdout, PEER_ACK-only stdout, or exit 0 without a valid
first line → `assign <id> refuse: unparsed-outcome`. Never `done` from exit 0.

**`done` handshake:** `done` is allowed only if the parsed first line is
`done` **and** either (a) the body includes `kind: ping` (ping completed
in-turn), or (b) a **terminal job id** on this machine is present and
`status` of that job is terminal (`isTerminalStatus`, including
`cancelled`). `done` with neither `kind: ping` nor a terminal job →
`refuse`. Nested `delegate` that is still running or missing → `refuse`.
Classification may stay in the model. **Completion may not.**

Wire format: `sendMessage` / HTTP `/peers/send` grow an optional
`hintHarness` (`claude|codex|grok|cursor|opencode`). CLI
`peers assign --hint-harness grok` sets it. Existing `--harness` stays the
**sender** identity on HTTP register. Do not stuff the hint into `text`.

Per-harness **worker** resumes (when the orchestrator starts a ping-style
harness turn): Codex `exec resume`, Grok `--resume`/`--single` or
`--continue`, OpenCode `--session`. No Cursor `--mode ask --trust` on those
argv. Unknown harness remains `inject-stub`. Claude stays native or
`native_required`.

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

`peers assign --wait-seconds` polls `GET /peers/inbox` on the destination
mailbox with the register token. Success **only** if some message `from` the
target session matches:

```
^assign <this-assign-id> (done|refuse|rerouted)\b
```

Any other peer-session text from `old-orch` is ignored (not success). Timeout
is reported on Mini; a late valid reply can still be read with
`peers inbox --name main`.

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
- Orchestrator prompt contains assign id, body, policy; a PEER_ACK-only prompt
  **fails** the test (do not stub `runWake` with `{status:0}` and call that
  `done`)
- Hint ignored → parsed `rerouted` + harness used in the reply body
- `waitForReply` rejects a reply that is not `assign <id> done|refuse|rerouted`
- PEER_ACK Cursor wake does **not** enqueue `assign <id> done`
- `pickMachine` does not return session `main`
- Existing skip-busy, skip-asleep, prefer-idle, assign ⟂ `delegate` import
  checks stay green (presence still must not import `dispatch.mjs`; waiting
  on a job id uses `status` as a subprocess, not an in-process chat bus)

## Rollout

1. Ship orchestrator consume (`buildOrchestratorPrompt`), outcome parse,
   `hintHarness`, wait first-line bind, `main` exclusion, and the tests
   above on `feat/peers-grok`. **Do not** tell operators to switch the 2017
   to `--harness grok` before this lands — that would keep PEER_ACK→`done`.
2. Then point 2017 presence at Grok, same `PEERS_DIR` as serve. Restart
   presence after pull. Cursor `old-orch` is wake-only until explicitly
   requested.
3. Mini keeps `main` as assigner. Prove: ping → `done`/`refuse` with real
   body; implement → 2017 `delegate` + reply with **terminal** job id;
   hint-Grok-when-down → `rerouted` or `refuse`; wait does not succeed on a
   PEER_ACK-era `done` that lacks the new first line bound to this id.

## Risks

- Grok `--single` on every assign costs a turn even for pings. Accepted: the orchestrator *is* Grok; pings stay short.
- `delegate` from an orchestrator turn can nest long jobs. Idle/busy covers the machine; the orchestrator turn must wait or the reply will lie. The orchestrator waits.
- Cursor wake-only path will confuse operators if left as default `old-orch`. Default presence harness for this fleet is Grok unless the operator explicitly asks for wake-only.

## Decisions after Cursor challenge (`ab179dc9`)

Accepted: no `done` from PEER_ACK or exit 0; one enqueue from parsed
outcome; `hintHarness` on the wire; wait binds to `assign <id> …`; exclude
`main` from pick; tests that fail on PEER_ACK-only consume; `done` after
implement requires a terminal local job id; do not switch 2017 presence
until consume ships.

Rejected as scope: Mini forcing a session id; HTTP `POST /peers/assign`;
pulling patches to Mini; treating “spec-only vs current Cursor ACK” as a
spec contradiction rather than a rollout hazard.
