---
name: setting-up-collaboration
description: Use when standing up this plugin on a new machine, joining the Tailscale fleet, running peers serve or presence, installing worker harnesses, or when setup/doctor is not worker-ready.
---

# Setting up collaboration

Two planes. Stand-up checklist, not a second spec:

| Plane | What | Authority |
|---|---|---|
| Cross-machine peer fleet | assign / consume / reply over Tailscale | `docs/specs/peers-fleet.md`, bind/auth `docs/specs/peers-serve.md` |
| Cross-harness job plane | `delegate` / `review` / `apply` | `agent-collaboration`, CLI `companion-runtime` |

Install: `README.md` (Install + After installing). Extras: `docs/README.grok.md`, `docs/README.opencode.md`, `examples/CURSOR.md`.

`C` = `scripts/agent-companion.mjs`.

## A — Cross-machine (Tailscale `100.x` only)

1. **Bind.** `AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on`. Listen on this machine’s Tailscale `100.x:8744`. Serve refuses `0.0.0.0` / `::`. Tailscale-only serve: `127.0.0.1:8744` will not work — use the `100.x` URL even locally. Set `AGENT_COLLAB_PEERS_URL` for HTTP clients.

2. **Pair file.** Same secret on every machine: `~/.agent-collaboration/peers-bridge.token` mode `0600`. Pass `AGENT_COLLAB_PEERS_PAIR` or `--pair`. Required for remote bind. Pair bearer: register / list / health. Per-peer token from register: send / inbox / heartbeat. Do not commit. Do not paste into chat. Never invent a pair value.

3. **Two processes, one mailbox.** Each awake host runs `peers serve` **and** `peers presence`. They **must share one directory** or assigns land nowhere.

   | Host | Shared mailbox | Env |
   |---|---|---|
   | Mac Mini M4 | `$HOME/.agent-collaboration/fleet` (peers under that data root) | `AGENT_COLLAB_DATA` |
   | 2017 MacBook Pro | `$HOME/.agent-collaboration/peers-macbook-serve` | `AGENT_COLLAB_PEERS_DIR` |

4. **Labels vs sessions.** Computers (not hostname): `Mac Mini M4`, `2017 MacBook Pro`, `MacBook Pro M4 Max`. `peers machine --computer "…" --url http://100.x:8744`. Sessions: `main` = assigner (not a target unless `--to main`); `mini-orch` / `old-orch` = presence. Re-registering `main` without `sessionId=main` mints `main-2`.

5. **Prove.** `peers machines` shows dest `available` + `idle`. Then `peers assign --from main --to-computer "2017 MacBook Pro" --wait-seconds 90 "…"`. Cursor `PEER_ACK` is wake-only, not `done`.

**REQUIRED SUB-SKILL after stand-up:** `peer-fleet`. Other computer is `peers assign`, not `delegate`.

Grok: a live TUI on that session → `refuse: session-live` (no `--single` over it).

## B — Cross-harness (same computer)

1. **Install** once per harness — `README.md`. Or drive `node "$C"` over the shell.

2. **Detect workers.**

   ```
   node "$C" setup
   node "$C" doctor --live
   ```

   `worker-ready` can run unattended. `interactive-only` cannot. Cursor needs `~/.cursor/bin/agent login` or `CURSOR_API_KEY`; **never bare `agent`** (often Grok). Node ≥ 20.

3. **Delegate.**

   ```
   node "$C" delegate --worker <h> --driver <self> "<brief>"
   node "$C" review  --worker <h> --driver <self> "<diff>"
   node "$C" apply <jobId>
   ```

   Pass `--driver`. Inspect, then apply. Keep the exact `jobId`.

## End-state

- [ ] Pair file 0600 on each machine; env set; not in git or chat
- [ ] Each awake host: serve on its `100.x:8744` + presence, **same** mailbox
- [ ] Labels + remote URLs registered; `main` / `*-orch` live
- [ ] `peers machines` dest available+idle; assign + wait works
- [ ] `setup` / `doctor --live` worker-ready for intended harnesses
- [ ] Can `delegate` and `apply` only after inspect
