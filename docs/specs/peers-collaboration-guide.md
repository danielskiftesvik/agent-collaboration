# Peer fleet collaboration guide (Mini ↔ 2017)

Operator and developer map for the **peer plane** that hands named work
between computers. This is **not** the job plane (`delegate` / `review` /
`apply`). Those stay local to the machine that does the work.

Branch: `feat/peers-grok`.
Proven live on 2026-08-15 between **Mac Mini M4** (`100.109.229.92:8744`)
and **2017 MacBook Pro** (`100.70.172.74:8744`). **MacBook Pro M4 Max**
(`100.109.243.67:8744`) may be registered; it is **not** required to be
awake.

Shorter operator notes also live in [`peers-fleet.md`](./peers-fleet.md)
and [`peers-serve.md`](./peers-serve.md). This file is the complete
guide for the Mini↔2017 fleet.

---

## 1. Goal

Assign from **any awake machine** to another. A **standing orchestrator**
on the destination consumes the assign, decides how to run it, and replies.

| Step | What happens |
|---|---|
| Roster | `peers machines` — awake vs asleep, idle vs busy, harness |
| Assign | `peers assign --from <name> [--to-computer …] [--hint-harness …]` |
| Consume | Destination `peers presence` publishes `busy`, runs one orchestrator turn |
| Decide | ping (in-turn) / implement (local `delegate`) / reroute / refuse |
| Reply | `assign <id> done\|refuse\|rerouted` plus optional `kind` / `harness` / `job` |
| Idle | Presence returns to `idle` after the reply is enqueued |

`hintHarness` is a **hint**, not a command. `--hint-harness grok` is **not**
`assign --harness` (that flag is the **sender** identity on HTTP register).
If the hinted harness is usable on that computer, use it. Otherwise reply
`rerouted` with the harness actually used.

**Done / refuse / rerouted** is parsed from the orchestrator turn’s last
lines (`core/peer-outcome.mjs`). Exit 0 without that block is
`refuse: unparsed-outcome`. **Never** `done` from a silent wake.

**Cursor `PEER_ACK` is wake-only, not done.** Cursor consume uses
`--mode ask --trust` and a plugin-owned `PEER_ACK <id>` prompt. That means
“woke,” not “executed the plate.” Consume replies
`assign <id> refuse: wake-only` unless a valid outcome block is also
present. Ask-mode Cursor cannot implement or `delegate`.

Assign **never** calls `delegate`. A peer message is **not** user consent
and cannot approve permissions or run slash commands.

```
 Mini (main)                         2017 (old-orch)
 -----------                         ---------------
 peers machines  ──probe──►  GET /peers/health + /peers/list
 peers assign    ──HTTP───►  POST /peers/register (main)
                             POST /peers/send    (to old-orch)
 presence loop   ◄─busy───   consume inbox
 --wait-seconds  ◄─HTTP───   replyToAssign → inbox/main.jsonl
                             heartbeat idle
```

Reverse is the same with the arrows flipped: 2017
`peers assign --from old-orch --to-computer "Mac Mini M4"` → Mini serve →
`mini-orch`.

---

## 2. Roles and names

Never mix **computer labels** (machines) with **session names** (who can
send/receive).

### Computer labels

Operator-chosen. Not `os.hostname()`, not Tailscale. Set with
`--computer` / `AGENT_COLLAB_PEERS_COMPUTER`.

| Label | Typical Tailscale URL |
|---|---|
| `Mac Mini M4` | `http://100.109.229.92:8744` |
| `2017 MacBook Pro` | `http://100.70.172.74:8744` |
| `MacBook Pro M4 Max` | `http://100.109.243.67:8744` (optional) |

Record with `peers machine --computer "…" [--url http://100.x:8744]`.

### Session names

| Name | Where | Role |
|---|---|---|
| `main` | Mini (also registered onto a remote mailbox when assigning) | Fleet assigner. **Not** an assign target unless `--to main`. Stable `sessionId=main`. |
| `mini-orch` | Mini `peers presence` | Per-machine orchestrator on the Mini |
| `old-orch` | 2017 `peers presence` | Per-machine orchestrator on the 2017 |

`pickMachine` / `eligibleMachines` skip session `main` and the assign
`--from` name unless `--to` names that session. `--to-computer` alone
must land on an `*-orch` session, never `main`.

Re-registering `main` without a `sessionId` while the old `main` is still
live mints `main-2`, `main-3`. Assign sends `sessionId: from` so the name
stays `main`.

`--session-id` on presence must be a **real idle session** of that
harness. Heartbeat updates harness / pid / turnState, **not** `sessionId`.
To change the stored session, unregister the name (or wait until it is
not live) and start presence again.

Do not run two `presence` loops for the same name.

### Two mailboxes

Each computer owns **its own** mailbox directory. There is no shared disk.

| Host | Mailbox root | Env |
|---|---|---|
| Mac Mini M4 | `$HOME/.agent-collaboration/fleet/peers` | `AGENT_COLLAB_DATA=$HOME/.agent-collaboration/fleet` (data root; peers dir is `<data>/peers`) |
| 2017 MacBook Pro | `$HOME/.agent-collaboration/peers-macbook-serve` | `AGENT_COLLAB_PEERS_DIR` (explicit mailbox root) |

`resolvePeersDir()`: `AGENT_COLLAB_PEERS_DIR` if set, else
`<resolveDataRoot()>/peers`.

**Presence and serve on the same computer must share that directory.** If
presence heartbeats into `~/.agent-collaboration/peers` while serve owns
`peers-macbook-serve`, assign lands in a box nobody consumes.

`reach: cross-machine` means “this identity arrived over HTTP.” The inbox
file still lives on **this** host.

---

## 3. Transport

Tailscale only. Bind is **not** `0.0.0.0` / `::` / `*`.

- Default listen: loopback (`127.0.0.1` / `localhost` / `::1`).
- `AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on` allows Tailscale CGNAT
  `100.64.0.0/10` only.
- Remote bind **requires** `--pair` / `AGENT_COLLAB_PEERS_PAIR`.
- No auto-probe. Clients set `AGENT_COLLAB_PEERS_URL` explicitly if they
  want HTTP instead of files. `127.0.0.1:8744` will **not** work if serve
  bound Tailscale-only — use the `100.x` URL, including from the same
  machine.

### Pair vs per-peer tokens

| Call | Auth |
|---|---|
| `GET /peers/health`, `GET /peers/list`, `POST /peers/register` | Bearer **pair** |
| `POST /peers/send`, `GET /peers/inbox`, `POST /peers/heartbeat`, unregister | Bearer **per-peer token** issued at register |

Unauthenticated health must be `401 {"error":"pair token required"}`.

The pair is the shared join secret. Same value on every machine. On the
Mini it lives in `~/.agent-collaboration/peers-bridge.token` (mode
`0600`) when that file exists. It is **not** written to the mailbox and
is **not** auto-generated. Do not commit it. Do not put it in chat.

Register returns a **per-peer** token. After a remote assign, the sender
stores that token in `<peersDir>/remote-inbox-tokens.json` so
`--wait-seconds` can poll `GET /peers/inbox` on the **destination**
mailbox.

### Fail-closed file send vs reply

| Path | Cross-machine dest (`reach: cross-machine`) |
|---|---|
| File-path `peers send` / `sendMessage` (default) | **Fail-closed** (`PEER_CROSS_MACHINE`) |
| HTTP `POST /peers/send` | Enqueues (`allowCrossMachine: true` on the daemon path) |
| `peers reply` / `replyToAssign` | Enqueues locally with `allowCrossMachine: true` |

Reply after an HTTP assign **must** enqueue on this mailbox: that is how
the sender reads the answer. Plain `send` to a listed remote is not a
local file write.

SSH is **not** the work path. Port 22 closed on the 2017 is expected.
Use SSH only for logs / process inspection if you have it.

---

## 4. CLI

Single runtime: `scripts/agent-companion.mjs`.

```
peers self | heartbeat | presence | register | unregister | list
peers machine | machines | eligible | pick | assign | send
peers inbox | lineage | deliver | consume | reply | serve
```

There is **no** standalone `peers wait` verb. Wait is
`peers assign --wait-seconds <n>`.

### Assign / pick / machines

```bash
# Roster (available vs activity vs harness)
node "$C" peers machines [--json]

# Eligible / pick (policy layer on the roster)
node "$C" peers eligible [--json]
node "$C" peers pick [--json]

# Assign (enqueue only; never delegate)
node "$C" peers assign --from <name> \
  [--to <session>] [--to-computer <label>] \
  [--hint-harness grok] [--wait-seconds 120] \
  "<text>"
```

| Flag | Meaning |
|---|---|
| `--from` | Sender session name (required on assign). Also HTTP-registered on the dest mailbox. |
| `--to` | Pin a session name. Without it, pick skips `main` and `--from`. |
| `--to-computer` | Pin a computer label (`2017 MacBook Pro`, `Mac Mini M4`). |
| `--hint-harness` | Optional `claude\|codex\|grok\|cursor\|opencode`. Stored on the message, not stuffed into `text`. |
| `--harness` | Sender identity on HTTP register, **not** the hint. |
| `--wait-seconds` | Poll dest `GET /peers/inbox` until a reply matches `assign <this-id> done\|refuse\|rerouted`. Timeout → `PEER_REPLY_TIMEOUT`. |

No eligible machine → `PEER_NO_CAPACITY`.

`peers pick` / assign prefer **idle**, then oldest `lastSeenAt`, then
computer name.

### Consume / presence

```bash
node "$C" peers presence --computer "<label>" --harness <h> \
  [--turn-state idle|busy] [--name <name>] [--session-id <id>] \
  [--interval-ms n] [--once] [--consume|--no-consume]

node "$C" peers consume --name <name> [--refuse <reason>]
node "$C" peers deliver --name <name> [--limit n]
```

`presence` is the machine-side loop (heartbeat ~30s, consume on by
default). `--once` is a single tick. `--no-consume` is heartbeat-only.

### Lineage / inbox / reply

```bash
node "$C" peers lineage --id <assign-id> [--json]
node "$C" peers inbox --name <name> [--ack]
node "$C" peers reply --from <name> --to <name> "<text>"
```

### Serve

```bash
AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on \
AGENT_COLLAB_PEERS_PAIR="$(cat ~/.agent-collaboration/peers-bridge.token)" \
node "$C" peers serve --listen 100.x.x.x:8744 --pair "$AGENT_COLLAB_PEERS_PAIR" \
  --computer "<label>"
```

---

## 5. Consume policy

`handleAssignedWork` (`core/peer-receive.mjs`):

1. Take the first inbox message.
2. Heartbeat `busy`.
3. `tryReceive` — harness-specific wake / inject.
4. Parse stdout with `parseAssignOutcome` / `finalizeAssignOutcome`.
5. `replyToAssign` once. Presence must **not** also `peers reply` (double
   enqueue). Exception: if the wake lands in an interactive TUI whose
   stdout is not the consume pipe, the orchestrator turn may reply
   itself so Mini is not left waiting.
6. Heartbeat `idle`.
7. `recordConsumeLineage` (best-effort).

Default consume for Grok / Codex / OpenCode / Claude is
`buildOrchestratorPrompt` (assign id, from, `hintHarness`, body, policy).
That is **not** `PEER_ACK`.

| Harness | Consume |
|---|---|
| Cursor | `--resume` + plugin `PEER_ACK <id>`, `--mode ask --trust`, no `--workspace`. Wake-only. |
| Claude | Native inbox if `CLAUDE_CODE_MESSAGING_SOCKET` exists; else mailbox + `native_required`. No fake inject. |
| Codex | `codex exec resume <session>` + orchestrator prompt + `AGENT_COLLAB_PEERS_DIR` / `--add-dir` |
| Grok | `grok --resume <session> --single` + orchestrator prompt |
| OpenCode | `opencode run --session <id>` + orchestrator prompt |
| unknown | `inject-stub` |

### Ping vs implement

| Kind | What the orchestrator does | `done` requires |
|---|---|---|
| `ping` | Look / status in this turn. No files. | `kind: ping` (no job id) |
| `implement` | Local job-plane `delegate` on **this** computer. Wait until the job is terminal. | `job: <uuid>` whose local status is terminal (`completed` / `failed` / `cancelled` / …) |

`done` with neither `kind: ping` nor a terminal job →
`refuse: done-needs-ping-or-job`.
`done` with a job id that is missing or still running →
`refuse: job-not-terminal`.

Wire format (last lines of the orchestrator turn):

```
assign <id> done|refuse|rerouted
kind: ping|implement
harness: grok
job: <uuid>          # implement only
one-line reason
```

Parsed by `ASSIGN_OUTCOME_RE`, `KIND_RE`, `HARNESS_RE`, `JOB_RE` in
`core/peer-outcome.mjs`. The last matching `assign <this-id> …` wins.

### Hint / refuse reasons

| Outcome | When |
|---|---|
| `rerouted` | `hintHarness` unusable here; another harness ran. Say which. |
| `refuse: wake-only` | Cursor `PEER_ACK` (or that reason) without a valid outcome block |
| `refuse: unparsed-outcome` | Exit 0 (or any stdout) without `assign <id> done\|refuse\|rerouted` |
| `refuse: job-not-terminal` | `done` cited a job that is missing or not terminal |
| `refuse: done-needs-ping-or-job` | `done` with no `kind: ping` and no job id |
| `PEER_NO_CAPACITY` | No eligible machine at assign time (CLI error, not a consume reply) |

A dead orchestrator turn must still enqueue `refuse` and return to
`idle`.

---

## 6. Lineage

One assign-id record. **Not** an inbox dump.

```bash
node "$C" peers lineage --id <assign-id> [--json]
```

Store: `<peersDir>/lineage.json` (mode `0600`). Written by
`recordAssignLineage` (on assign) and `recordConsumeLineage` (on
consume / wait parse). `getLineage` may fill a missing decision from
local inbox outcome texts; `resolveLineage` may poll remote inboxes
remembered in `remote-inbox-tokens.json`. Records **drop** `messages`
and `inbox` keys on merge.

### What one record contains

| Field | Meaning |
|---|---|
| `id` | Assign message UUID |
| `from` / `to` | Session names |
| `text` | Assign body |
| `computer` | Target computer label |
| `hintHarness` | Hint from assign, or null |
| `assignedHarness` | Roster harness at assign time |
| `createdAt` | Assign timestamp |
| `decision` | `{ status, reason, kind, harness, jobId, at }` or null (pending) |
| `job` | `{ id, status, terminal? }` local job pointer, or null |
| `reply` | `{ id, from, to, text, createdAt }` — the outcome reply, not the whole inbox |

`peers lineage --id` fails if the id is unknown (no `createdAt`, `from`,
or `decision`). Human format is `formatLineage`: who → whom on which
computer, hint, decision, job pointer, reply text.

---

## 7. UI

On a machine running `peers serve`:

```
http://<tailscale-ip>:8744/collab
```

Examples: `http://100.109.229.92:8744/collab` (Mini),
`http://100.70.172.74:8744/collab` (2017).

| Path | What |
|---|---|
| `GET /collab` | `ui/collaboration.html` + classic scripts |
| `GET /collab/collaboration-view.js` | View: roster cards, assign list, one lineage detail |
| `GET /collab/collaboration-page.js` | Fetches live JSON; `file:` uses fixture |
| `GET /peers/collab` | `{ machines: listMachines(probes), assigns: listLineage() }` |

The page lists **machines** (awake/asleep, activity, harness, session)
and **recent assigns**. Selecting a row shows **one lineage** (decision,
harness, job, reply). It is **not** a chat log.

Opening `ui/collaboration.html` as `file:` shows embedded fixture data
and a banner:

> Opened as a file. Showing fixture data. For live fleet state open
> `http://<this-machine>:8744/collab` via peers serve.

`file://` cannot read `lineage.json` (CORS). Live state requires serve.

---

## 8. Files and modules

Peer plane must **not** import `core/dispatch.mjs`. Waiting on a job id
uses the `status` CLI as a subprocess, not an in-process chat bus.

| Path | Role |
|---|---|
| `core/peer-assign.mjs` | `assignTask`, `waitForReply`. Pick eligible machine; HTTP register+send or local send; record assign lineage. |
| `core/peer-receive.mjs` | Orchestrator prompt, idle-resume argv, `tryReceive`, `handleAssignedWork` (busy → work → reply → idle). |
| `core/peer-outcome.mjs` | Parse / finalize `assign <id> done\|refuse\|rerouted` + `kind` / `harness` / `job`. |
| `core/peer-lineage.mjs` | `lineage.json` store; assign/consume records; `getLineage` / `resolveLineage` / `formatLineage`. |
| `core/peer-reply.mjs` | `replyToAssign` — same peer-session shape, `allowCrossMachine: true`. |
| `core/peer-inject-cursor.mjs` | Cursor wake: `PEER_ACK`, `--mode ask --trust`. |
| `core/peer-presence.mjs` | Heartbeat tick + consume loop (~30s). |
| `core/peers.mjs` | Mailbox, registry, send/inbox, machines roster, pick/eligible, fail-closed send. |
| `core/peers-serve.mjs` | HTTP daemon, pair/peer auth, Tailscale bind, `/collab`, `/peers/collab`. |
| `ui/collaboration.html` | Page + `file:` fixture |
| `ui/collaboration-view.js` | `lineageToView`, `rosterToView`, `installCollaboration` (classic script) |
| `ui/collaboration-page.js` | Live `GET /peers/collab` or fixture banner |
| `scripts/agent-companion.mjs` | CLI surface for every `peers *` verb |
| `docs/specs/peers-fleet.md` | Operator map (computers, proven legs) |
| `docs/specs/peers-serve.md` | Serve / bind / auth notes |
| `docs/superpowers/specs/2026-08-15-machine-orchestrator-design.md` | Design: goal, non-goals, handshake |

Job plane (local implement only): `delegate`, `status`, `result`,
`apply` — same companion, **this computer only**.

---

## 9. Ops: prove ping / implement / lineage

SSH is for **logs only**, not the work path. The work path is:

1. Both sides: `peers serve` + `peers presence` sharing that host’s mailbox.
2. `peers machines` shows dest `available` + `idle` + write-capable harness
   (Grok on 2017 `old-orch` / Mini `mini-orch`).
3. Assign over HTTP. Presence consumes. Reply comes back on the sender’s
   wait or `peers inbox`.

### Standing processes

Each awake computer runs **two** long-lived processes from this branch:

1. `peers serve` — owns mailbox files; HTTP enqueue.
2. `peers presence` — heartbeat ~30s; consume assigns.

Restart **presence** after a `git pull` (node has the old code loaded).
Serve can stay unless the HTTP contract changed.

#### Mini

```bash
export AGENT_COLLAB_DATA="$HOME/.agent-collaboration/fleet"
export AGENT_COLLAB_PEERS_PAIR="$(cat ~/.agent-collaboration/peers-bridge.token)"
export AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on
export AGENT_COLLAB_PEERS_COMPUTER="Mac Mini M4"
C=/path/to/agent-collaboration/scripts/agent-companion.mjs

node "$C" peers machine --computer "Mac Mini M4"
node "$C" peers machine --computer "2017 MacBook Pro" --url http://100.70.172.74:8744
node "$C" peers register --name main --harness grok --session-id main

node "$C" peers serve --listen 100.109.229.92:8744 --computer "Mac Mini M4"
node "$C" peers presence --computer "Mac Mini M4" --harness grok \
  --turn-state idle --name mini-orch --session-id <real-idle-grok-session>
```

#### 2017

```bash
export AGENT_COLLAB_PEERS_PAIR="$(cat ~/.agent-collaboration/peers-bridge.token)"
export AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on
export AGENT_COLLAB_PEERS_DIR="$HOME/.agent-collaboration/peers-macbook-serve"
export AGENT_COLLAB_PEERS_COMPUTER="2017 MacBook Pro"
C=/path/to/agent-collaboration/scripts/agent-companion.mjs

node "$C" peers serve --listen 100.70.172.74:8744 --computer "2017 MacBook Pro"
node "$C" peers presence --computer "2017 MacBook Pro" --harness grok \
  --turn-state idle --name old-orch --session-id <real-idle-grok-session>
node "$C" peers machine --computer "Mac Mini M4" --url http://100.109.229.92:8744
```

If `peers-bridge.token` is missing on the 2017, recover the pair from the
already-running serve argv (do not paste it into chat). Cursor presence on
`old-orch` will steal the name and flip harness back to wake-only — stop
it before Grok presence.

### Prove ping

```bash
# Mini → 2017
node "$C" peers assign --from main --to-computer "2017 MacBook Pro" \
  --hint-harness grok --wait-seconds 120 \
  "PING: do not change files. One line: hostname."

# 2017 → Mini (run on the 2017)
node "$C" peers assign --from old-orch --to-computer "Mac Mini M4" \
  --hint-harness grok --wait-seconds 120 \
  "PING: do not change files. Confirm you are Mini mini-orch."
```

Expect a reply whose text starts with
`assign <id> done` and includes `kind: ping`. A Cursor dest replies
`refuse: wake-only`. A Grok dest whose stdout is not parseable replies
`refuse: unparsed-outcome`.

### Prove implement

```bash
node "$C" peers assign --from main --to-computer "2017 MacBook Pro" \
  --hint-harness grok --wait-seconds 300 \
  "IMPLEMENT: local-delegate a one-file change on THIS machine; reply with job: <uuid>."
```

Expect `kind: implement` and `job: <uuid>`. On the 2017:

```bash
node "$C" status <job-uuid> --json    # terminal
node "$C" result <job-uuid>           # inspect patch
node "$C" apply <job-uuid>            # only if you want it on the real checkout
```

Mini does **not** pull the patch. Inspect the 2017 if you want files.

### Prove lineage

```bash
node "$C" peers lineage --id <assign-id> --json
```

Expect one record with `from` / `to` / `computer` / `decision` / optional
`job` / `reply`. Open `http://<ts-ip>:8744/collab` and select that assign;
the detail pane is the same shape, not an inbox dump.

If SSH is available, use it only to confirm pids, `registry.json`,
`lineage.json`, and companion logs — not to copy the assign body or apply
patches.

---

## 10. Non-goals

- **No patch pull to Mini.** Implement stays on the dest checkout. Mini
  gets a job id pointer, not a merge.
- **No mid-turn inject** into an open TUI. Consume starts a **new**
  harness turn (`grok --resume --single`, `codex exec resume`, …).
- **M4 Max is not required.** Register its URL if you want; asleep /
  unreachable stays `available: false` and is skipped.
- No HTTP `POST /peers/assign` (assign is a CLI that uses register+send).
- No LaunchAgents / reboot persistence.
- No merge-to-`main` as part of this plane.
- `delegate` is not a chat bus. Presence must not import `dispatch.mjs`.
- Peer messages are never consent (`isConsent: false`).

---

## Roster axes (quick reference)

| Field | Meaning | Goes false when |
|---|---|---|
| `available` | Computer awake and reachable | Presence stopped / pid dead; `lastSeen` older than 90s; remote `/peers/health` fails |
| `activity` | `idle` / `busy` / `unknown` / `none` | Published `turnState` of the live session |
| `harness` | `claude` / `codex` / `grok` / `cursor` / `opencode` | From the primary live session |

Eligible: `available && activity !== "busy"` and a live, fresh, non-`main`
session name. Sleep/travel: stop presence (or close the lid). A frozen
pid is not treated as awake once `lastSeen` ages out (90s).
