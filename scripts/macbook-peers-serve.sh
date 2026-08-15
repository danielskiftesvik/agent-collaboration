#!/usr/bin/env bash
# Reverse dual-Mac: run ON MacBook. Serves on Tailscale IP :8744.
# Requires AGENT_COLLAB_PEERS_PAIR (same secret the mini will send).
# Mini: PEERS_URL=http://<this-ts-ip>:8744 AGENT_COLLAB_PEERS_PAIR=... ./scripts/mini-send-to-macbook.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="$(tailscale ip -4 | awk '{print $1; exit}')"
PORT="${AGENT_COLLAB_PEERS_BRIDGE_PORT:-8744}"
PAIR="${AGENT_COLLAB_PEERS_PAIR:?set AGENT_COLLAB_PEERS_PAIR to a shared secret}"
export AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on
export AGENT_COLLAB_PEERS_DIR="${AGENT_COLLAB_PEERS_DIR:-$HOME/.agent-collaboration/peers-macbook-serve}"
export AGENT_COLLAB_PEERS_PAIR="$PAIR"
mkdir -p "$AGENT_COLLAB_PEERS_DIR"
COMPUTER="${AGENT_COLLAB_PEERS_COMPUTER:-}"
ARGS=(peers serve --listen "${HOST}:${PORT}" --pair "$PAIR")
if [[ -n "$COMPUTER" ]]; then
  ARGS+=(--computer "$COMPUTER")
fi
echo "MacBook serve http://${HOST}:${PORT} computer=${COMPUTER:-unset} (pair required, dir=$AGENT_COLLAB_PEERS_DIR)"
exec node "$ROOT/scripts/agent-companion.mjs" "${ARGS[@]}"
