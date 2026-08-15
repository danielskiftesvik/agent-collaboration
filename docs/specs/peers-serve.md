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
