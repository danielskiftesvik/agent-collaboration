# peers serve

Mailbox daemon. Owns the peers files so clients that cannot write `$HOME`
can talk over HTTP. File mailbox remains the default.

## Bind

- Default: loopback only (`127.0.0.1` / `localhost` / `::1`).
- `AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on` allows Tailscale CGNAT
  `100.64.0.0/10` only.
- Always refuses `0.0.0.0` / `::` / `*`.
- No auto-probe. Clients set `AGENT_COLLAB_PEERS_URL` explicitly.

## Auth

- Register issues a per-peer token.
- Send / inbox / unregister / heartbeat require that token.
- `GET /peers/list` and `GET /peers/health` are **unauthenticated**.
  Treat remote bind as **transport**, not a pair table.

## Cross-machine

- File-path `sendMessage` still fail-closes when `dest.reach === "cross-machine"`.
- HTTP `/peers/send` may enqueue (`allowCrossMachine: true` on the daemon path).
- Pairing (daemon-side credentials, not “anyone who can hit `/register`”) is
  unfinished. Reverse mini→MacBook is a smoke, not a merge gate.

## Inject

`peers serve` does not wake anyone. `peers deliver` is the consumer.
