# Peer fleet: cross-machine handoff

This is the operator map for handing work between computers. It is **not**
`delegate` / `review` / `apply`. Those stay the job plane (worktrees, patches).
This plane is named plain-text assign → consume → reply, over a local mailbox
or Tailscale HTTP.

Proven on 2026-08-15 between **Mac Mini M4** (`100.109.229.92:8744`) and
**2017 MacBook Pro** (`100.70.172.74:8744`). **MacBook Pro M4 Max**
(`100.109.243.67:8744`) is registered but need not be awake.

Branch: `feat/peers-grok`.

## What a “handoff” is

A **main orchestrator** (a named peer, usually `main` on the Mini) looks at the
fleet roster and **assigns** a text task to one **per-machine orchestrator**
(a live `presence` session on that computer). That machine:

1. Accepts (heartbeat `busy` so a second assign skips it).
2. Consumes the mailbox. Default consume is an **orchestrator prompt**
   (assign body + ping / implement / hint / refuse). Cursor `PEER_ACK` is
   wake-only and cannot yield `assign done`.
3. Replies with the same peer-session shape (`from` = machine session, text
   present, `isConsent: false`).
4. Returns to `idle`.

Assign never calls `delegate`. A peer message is not user consent and cannot
approve permissions or run slash commands.

```
 Mini (main)                         2017 (old-orch)
 -----------                         ---------------
 peers machines  ──probe──►  GET /peers/health + /peers/list
 peers assign    ──HTTP───►  POST /peers/register (main)
                             POST /peers/send    (to old-orch)
 presence loop   ◄─busy───   consume inbox
 wait --inbox    ◄─HTTP───   replyToAssign → inbox/main.jsonl
                             heartbeat idle
```

Reverse is the same with the arrows flipped: 2017 `peers assign
--to-computer "Mac Mini M4"` → Mini serve → `mini-orch` presence.

## Two mailboxes, not one chat

Each computer owns **its own** mailbox directory. There is no shared disk.

| Host | Suggested mailbox | Who writes it |
|---|---|---|
| Mac Mini M4 | `$HOME/.agent-collaboration/fleet` (`AGENT_COLLAB_DATA`) | Mini `peers serve` + Mini `presence` |
| 2017 MacBook Pro | `$HOME/.agent-collaboration/peers-macbook-serve` (`AGENT_COLLAB_PEERS_DIR`) | 2017 `peers serve` + 2017 `presence` |

**Presence and serve on the same computer must share that directory.** If
presence heartbeats into `~/.agent-collaboration/peers` while serve owns
`peers-macbook-serve`, assign lands in a box nobody consumes.

`reach: cross-machine` on a name means “this identity arrived over HTTP.”
The inbox file still lives on **this** host. File-path `peers send` to that
name fail-closes (so you cannot pretend a listed remote is a local file).
`peers reply` after an HTTP assign **does** enqueue locally (`allowCrossMachine`),
because that is how the sender reads the answer (`GET /peers/inbox` with the
token issued at register).

## Names (people) vs computers (machines)

Never mix these.

**Computer labels** (operator-chosen, not hostname, not Tailscale):

- `Mac Mini M4`
- `2017 MacBook Pro`
- `MacBook Pro M4 Max`

Recorded with `peers machine --computer "…" [--url http://100.x:8744]`.

**Session names** (who can send/receive):

| Name | Where | Role |
|---|---|---|
| `main` | Mini (and registered onto a remote mailbox when assigning) | Fleet orchestrator. Prefer **not** an assign target. Use a stable `sessionId=main`. |
| `mini-orch` | Mini presence | Per-machine worker on the Mini. |
| `old-orch` | 2017 presence | Per-machine worker on the 2017. |

Re-registering `main` without a `sessionId` while the old `main` is still live
mints `main-2`, `main-3`. Assign now sends `sessionId: from` so the name stays
`main`.

## Two axes on `peers machines`

| Field | Meaning | Goes false when |
|---|---|---|
| `available` | Computer is awake and reachable | Presence stopped / pid dead; or lastSeen older than 90s (frozen pid); or remote `/peers/health` fails |
| `activity` | `idle` / `busy` / `unknown` / `none` | Published `turnState` of the live session |
| `harness` | `claude` / `codex` / `grok` / `cursor` / `opencode` | From the primary live session |

Eligible for assign: `available && activity !== "busy" && session.name`.
`peers pick` / `peers assign` prefer **idle**, then oldest `lastSeenAt`, then
name. `--to-computer "2017 MacBook Pro"` pins the target.

Sleep/travel: stop presence (or close the lid). No manual “I’m asleep”
heartbeat. A process that is frozen but still has a pid becomes unavailable
after 90s without a fresh lastSeen.

## Transport and auth

Tailscale only. Bind is **not** `0.0.0.0`.

- Mini: `http://100.109.229.92:8744`
- 2017: `http://100.70.172.74:8744`
- M4 Max (when awake): `http://100.109.243.67:8744`

`AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on` is required for a `100.x` listen.
`--pair` / `AGENT_COLLAB_PEERS_PAIR` is required for that bind. Same secret on
every machine. On the Mini it lives in
`~/.agent-collaboration/peers-bridge.token` (mode `0600`). Do not commit it.
Do not put it in chat.

| Call | Auth |
|---|---|
| `GET /peers/health`, `GET /peers/list`, `POST /peers/register` | Bearer **pair** |
| `POST /peers/send`, `GET /peers/inbox`, `POST /peers/heartbeat`, unregister | Bearer **per-peer token** from register |

Unauthenticated health must be `401 {"error":"pair token required"}`.

`127.0.0.1:8744` will **not** work if serve bound Tailscale-only. Use the
`100.x` URL, including from the same machine when talking to its own serve.

SSH is not part of this plane. Port 22 closed on the 2017 is expected.

## Standing processes

Each awake computer runs **two** long-lived processes from
`.worktrees/peers-grok` on `feat/peers-grok`:

1. **`peers serve`** — owns the mailbox files; accepts HTTP enqueue.
2. **`peers presence`** — heartbeat ~30s (`--interval-ms` injectable) and
   consume. Default consume on; `--no-consume` is heartbeat-only.

### Mini

```bash
export AGENT_COLLAB_DATA="$HOME/.agent-collaboration/fleet"
export AGENT_COLLAB_PEERS_PAIR="$(cat ~/.agent-collaboration/peers-bridge.token)"
export AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on
export AGENT_COLLAB_PEERS_COMPUTER="Mac Mini M4"
C=/path/to/.worktrees/peers-grok/scripts/agent-companion.mjs

# once
node $C peers machine --computer "Mac Mini M4"
node $C peers machine --computer "2017 MacBook Pro" --url http://100.70.172.74:8744
node $C peers machine --computer "MacBook Pro M4 Max" --url http://100.109.243.67:8744
node $C peers register --name main --harness grok --session-id main

# leave running
./scripts/mini-peers-serve.sh
node $C peers presence --computer "Mac Mini M4" --harness grok \
  --turn-state idle --name mini-orch --session-id <real-grok-session>
```

### 2017

```bash
export AGENT_COLLAB_PEERS_PAIR='<same secret as Mini>'
export AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on
export AGENT_COLLAB_PEERS_DIR="$HOME/.agent-collaboration/peers-macbook-serve"
export AGENT_COLLAB_PEERS_COMPUTER="2017 MacBook Pro"
C=/path/to/.worktrees/peers-grok/scripts/agent-companion.mjs

./scripts/macbook-peers-serve.sh
node $C peers presence --computer "2017 MacBook Pro" --harness cursor \
  --turn-state idle --name old-orch --session-id <real-cursor-session>
node $C peers machine --computer "Mac Mini M4" --url http://100.109.229.92:8744
```

Restart **presence** after a `git pull` (node has the old code loaded). Serve
can stay unless the HTTP contract changed.

**Do not switch 2017 presence to `--harness grok` until this consume commit
is on that machine.** Cursor `old-orch` stays wake-only until then. A machine
still running pre-consume presence would treat a silent Grok exit as
`assign done`.

## Assign, consume, reply

```bash
# Mini → 2017
node $C peers assign --from main --to-computer "2017 MacBook Pro" \
  --wait-seconds 90 "run the next plate"

# 2017 → Mini (on the 2017, same pair + its PEERS_DIR)
node $C peers assign --from old-orch --to-computer "Mac Mini M4" \
  --wait-seconds 90 "look at the failing test"
```

Watch the fleet in a browser on a machine running `peers serve`:
`http://<tailscale-ip>:8744/collab`. The page lists machines and recent
assigns and shows one lineage (decision, harness, job, reply). It is not a
chat log. Opening `ui/collaboration.html` as a `file:` shows fixture data
and tells you to use serve for live state.

`--wait-seconds` polls `GET /peers/inbox` on the **destination mailbox** with
the token from register. The Mini stores that token under
`<peersDir>/remote-inbox-tokens.json`. `peers inbox --name main` will use it
when the local inbox is empty.

Default consume is the **orchestrator prompt** (assign id, from,
`hintHarness`, body, and ping / implement / hint / refuse). That is **not**
`PEER_ACK`. Grok / Codex / OpenCode / Claude get that prompt on the
orchestrator turn (Claude still does not fake-inject: native socket or
`native_required`). Cursor stays a wake-only plugin path.

| Harness | What consume does |
|---|---|
| Cursor | `--resume` + plugin `PEER_ACK <id>` prompt, `--mode ask --trust`, no `--workspace`. Wake-only: `PEER_ACK` cannot yield `assign done` (`refuse: wake-only` unless a valid outcome block is also present) |
| Claude | Native inbox if `CLAUDE_CODE_MESSAGING_SOCKET` exists; else mailbox + `native_required` (no fake inject) |
| Codex | `codex exec resume <session>` + orchestrator prompt + `AGENT_COLLAB_PEERS_DIR` / `--add-dir` |
| Grok | `grok --resume <session> --single` + orchestrator prompt |
| OpenCode | `opencode run --session <id>` + orchestrator prompt |
| unknown | `inject-stub` |

**Cursor limitation (important):** the wake prompt is a fixed plugin string
with the message id only. Raw assign text is **not** on argv (`--mode ask` is
read-only). `PEER_ACK` means “woke,” not “executed the plate,” and consume
replies `assign <id> refuse: wake-only`. Exit 0 without a parsed
`assign <id> done|refuse|rerouted` is `refuse: unparsed-outcome`, never
`done`. Grok/Codex/OpenCode resume a real new turn with the orchestrator
prompt and that harness’s flags; a missing session id refuses honestly and
still replies.

## What was proven live

| Leg | Result |
|---|---|
| Mini `assign` → 2017 `old-orch` | HTTP enqueue; presence went busy then idle |
| 2017 reply → Mini `wait` | `from: old-orch` `assign <id> done` `isConsent: false` |
| 2017 roster has Mini URL | `peers machine --computer "Mac Mini M4" --url http://100.109.229.92:8744` |
| Reverse HTTP into Mini `mini-orch` | consume + reply (`refuse`: no Grok session `fleet-mini`) |
| Asleep/unreachable M4 Max | `available: false`, skipped |
| File-path send to `reach: cross-machine` | still fail-closed |
| Reply without `allowCrossMachine` | crashed presence (fixed `6edce8d`) |

Those live `assign <id> done` replies were Cursor `PEER_ACK`-as-done. After
orchestrator consume, that path is `refuse: wake-only` and cannot yield
`assign done`.

## Hygiene

Do not run two `presence` loops for the same name. On the Mini, drop leftover
isolated processes (other worktrees / other ports) so `mini-orch` is one pid.

`--session-id` must be a **real** idle session if you want that harness to
resume work. A placeholder still consume+replies; without a parsed outcome
block the reply is `refuse: unparsed-outcome`, not `done`.
