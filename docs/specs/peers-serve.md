# peers serve

Mailbox daemon. Owns the peers files so clients that cannot write `$HOME`
can talk over HTTP. File mailbox remains the default.

## Computer names

Operator-chosen label on the machine, not `os.hostname()` and not Tailscale.
`--computer` / `AGENT_COLLAB_PEERS_COMPUTER`. Spaces allowed (`Mac Mini M4`).

- `peers serve --computer "2017 MacBook Pro"` — health reports it; HTTP
  register inherits it unless the body sets `computer`.
- `peers register|self --computer "Mac Mini M4"` — stored on the peer and
  shown by `peers list`.

Suggested labels for this fleet: `Mac Mini M4`, `2017 MacBook Pro`,
`MacBook Pro M4 Max`.

## Machine availability (orchestrator roster)

Two axes, never mixed:

| Field | Meaning |
|---|---|
| `available` | Computer is **awake and reachable**. False if asleep, offline, or traveling. |
| `activity` | Live session `turnState`: `busy` / `idle` / `unknown` / `none`. |

`peers machines` is what a main orchestrator reads before handing work to a
per-machine orchestrator.

- Local: available if a heartbeat (or session lastSeen) is newer than 90s.
  Laptops that sleep stop heartbeating; they become unavailable without a
  dead-pid check (frozen processes still have pids).
- Remote: register the serve URL once on the orchestrator host:
  `peers machine --computer "2017 MacBook Pro" --url http://100.x:8744`
  then `peers machines` probes `/peers/health`. No answer → unavailable.
- Agents on an awake machine should run `peers presence --computer <label>
  --harness <h> --turn-state idle|busy` (or `peers heartbeat` on the same
  fields) about every 30s. Stopping that process makes the computer
  unavailable. A frozen pid is not treated as awake once lastSeen ages out.

This is the roster. Assign is the policy layer on top:

- Eligible: `available && activity !== "busy"` and a live session name.
- `peers pick` chooses idle before unknown, then oldest `lastSeenAt`.
- `peers assign --from <orchestrator> <text>` enqueues to that session
  (HTTP if the machine has a serve URL). Refuses with `PEER_NO_CAPACITY`
  when every computer is asleep or busy. After accept, presence publishes
  `busy` so a second assign skips that machine. On finish or refuse the
  machine `peers reply`s to the orchestrator name (peer-session text, not
  consent) and returns to `idle`.

The 2017 MacBook Pro and MacBook Pro M4 Max need not be awake for assign on
this Mini. Record their serve URLs with `peers machine --computer … --url …`;
unreachable / asleep remotes stay `available: false`. Remote assign may stay
HTTP-enqueue.

Plain `peers send` is unchanged (no policy). Job-plane `delegate` is unchanged.

## Receive

`peers deliver` / `peers consume` are the consumers. Assign never calls
`delegate`.

| Harness | Idle consume |
|---|---|
| Cursor | Existing `--resume` + `PEER_ACK`, `--mode ask --trust`, no `--workspace` |
| Claude | Native `SendMessage` / inbox if `CLAUDE_CODE_MESSAGING_SOCKET` is present; otherwise mailbox consume + `native_required`. Do not fake a Claude inject. |
| Codex | Mailbox consume + `codex exec resume <session>` (set `AGENT_COLLAB_PEERS_DIR`; `--add-dir` when possible). EPERM stays honest. |
| Grok | Mailbox consume + `grok --resume <session> --single <prompt>` |
| OpenCode | Mailbox consume + `opencode run --session <id>` |
| unknown | `inject-stub` |

## Bind

- Default: loopback only (`127.0.0.1` / `localhost` / `::1`).
- `AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on` allows Tailscale CGNAT
  `100.64.0.0/10` only.
- Always refuses `0.0.0.0` / `::` / `*`.
- No auto-probe. Clients set `AGENT_COLLAB_PEERS_URL` explicitly.

## Auth

- Loopback: register/list/health may omit a pair (local process).
- Non-loopback bind **requires** `--pair` or `AGENT_COLLAB_PEERS_PAIR`. Serve
  refuses to listen without it.
- When a pair is configured, register / list / health require
  `Authorization: Bearer <pair>`.
- Register then issues a **per-peer** token. Send / inbox / unregister /
  heartbeat use that token (not the pair).
- Pair lives in the operator env / `--pair`. It is not written to the mailbox
  and is not auto-generated.

## Cross-machine

- File-path `sendMessage` still fail-closes when `dest.reach === "cross-machine"`.
- HTTP `/peers/send` may enqueue (`allowCrossMachine: true` on the daemon path).
- Reverse mini→MacBook is a smoke (needs a listener + the same pair on both
  sides). Not a merge gate.

## Inject

`peers serve` does not wake anyone. `peers deliver` is the consumer.
