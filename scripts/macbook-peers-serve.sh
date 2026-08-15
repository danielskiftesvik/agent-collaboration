#!/bin/bash
# Reverse dual-Mac: run ON MacBook. Starts peers serve on Tailscale IP :8744.
# Mini then: PEERS_URL=http://<this-ts-ip>:8744 ./scripts/mini-send-to-macbook.sh
set -euo pipefail
HOST="$(tailscale ip -4 | awk '{print $1; exit}')"
PORT="${AGENT_COLLAB_PEERS_BRIDGE_PORT:-8744}"
ROOT="${AGENT_COLLAB_PEERS_CURSOR_ROOT:-$HOME/GitRepos/agent-collaboration/.worktrees/peers-cursor}"
if [[ ! -f "$ROOT/scripts/agent-companion.mjs" ]]; then
  # Fall back: fetch companion+serve from mini oneshot bundle if present later.
  echo "missing $ROOT/scripts/agent-companion.mjs — clone/sync peers-cursor worktree first" >&2
  exit 1
fi
export AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on
export AGENT_COLLAB_PEERS_DIR="${AGENT_COLLAB_PEERS_DIR:-$HOME/.agent-collaboration/peers-macbook-serve}"
mkdir -p "$AGENT_COLLAB_PEERS_DIR"
echo "MacBook reverse serve http://${HOST}:${PORT} dir=$AGENT_COLLAB_PEERS_DIR"
echo "FROM_MINI: PEERS_URL=http://${HOST}:${PORT} $ROOT/scripts/mini-send-to-macbook.sh"
exec /usr/bin/env node "$ROOT/scripts/agent-companion.mjs" peers serve --listen "${HOST}:${PORT}"
