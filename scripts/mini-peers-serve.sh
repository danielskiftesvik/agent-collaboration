#!/usr/bin/env bash
# Run ON the Mini. Serves on Tailscale IP :8744 so laptops can assign back.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="$(tailscale ip -4 | awk '{print $1; exit}')"
PORT="${AGENT_COLLAB_PEERS_BRIDGE_PORT:-8744}"
PAIR="${AGENT_COLLAB_PEERS_PAIR:?set AGENT_COLLAB_PEERS_PAIR (same secret as the MacBooks)}"
export AGENT_COLLAB_PEERS_ALLOW_REMOTE_BIND=on
export AGENT_COLLAB_DATA="${AGENT_COLLAB_DATA:-$HOME/.agent-collaboration/fleet}"
export AGENT_COLLAB_PEERS_PAIR="$PAIR"
export AGENT_COLLAB_PEERS_COMPUTER="${AGENT_COLLAB_PEERS_COMPUTER:-Mac Mini M4}"
mkdir -p "$AGENT_COLLAB_DATA"
echo "Mini serve http://${HOST}:${PORT} computer=${AGENT_COLLAB_PEERS_COMPUTER} (dir=$AGENT_COLLAB_DATA)"
exec node "$ROOT/scripts/agent-companion.mjs" peers serve --listen "${HOST}:${PORT}" --pair "$PAIR" --computer "$AGENT_COLLAB_PEERS_COMPUTER"
